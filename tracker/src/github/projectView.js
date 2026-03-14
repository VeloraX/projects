const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
const DEFAULT_FETCH_ITEM_COUNT = 50;
const DEFAULT_RESPONSE_ITEM_LIMIT = 8;
const MAX_RESPONSE_ITEM_LIMIT = 10;
const DASHBOARD_LANE_ITEM_LIMIT = 4;

const FIELD_NAMES = Object.freeze({
  title: 'Title',
  status: 'Status',
  priority: 'Priority',
  driver: 'Driver',
  notes: 'Notes',
  targetDate: 'Target date',
  iteration: 'Iteration',
  size: 'Size'
});

const PROJECT_VIEW_QUERY = `query ProjectView($org: String!, $number: Int!, $itemsFirst: Int!) {
  organization(login: $org) {
    projectV2(number: $number) {
      id
      title
      url
      closed
      items(first: $itemsFirst) {
        nodes {
          id
          content {
            __typename
            ... on DraftIssue {
              title
            }
            ... on Issue {
              title
              url
              state
            }
            ... on PullRequest {
              title
              url
              state
            }
          }
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field {
                  ... on ProjectV2SingleSelectField {
                    name
                  }
                }
              }
              ... on ProjectV2ItemFieldTextValue {
                text
                field {
                  ... on ProjectV2FieldCommon {
                    name
                  }
                }
              }
              ... on ProjectV2ItemFieldDateValue {
                date
                field {
                  ... on ProjectV2FieldCommon {
                    name
                  }
                }
              }
              ... on ProjectV2ItemFieldIterationValue {
                title
                field {
                  ... on ProjectV2IterationField {
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export async function fetchGitHubProjectView({
  token,
  org,
  projectNumber,
  status = 'all',
  limit = DEFAULT_RESPONSE_ITEM_LIMIT,
  fetchImpl = fetch
}) {
  if (!token) {
    throw createConfigurationError('GITHUB_TOKEN is required before the tracker can read GitHub Projects.');
  }

  if (!org) {
    throw createConfigurationError('GITHUB_ORG is required before the tracker can read GitHub Projects.');
  }

  if (!Number.isInteger(projectNumber)) {
    throw createConfigurationError('GITHUB_PROJECT_NUMBER must be set to the target GitHub Project number.');
  }

  const payload = await executeGitHubGraphql({
    token,
    query: PROJECT_VIEW_QUERY,
    variables: {
      org,
      number: projectNumber,
      itemsFirst: DEFAULT_FETCH_ITEM_COUNT
    },
    fetchImpl
  });

  const project = payload.data?.organization?.projectV2;

  if (!project) {
    const error = new Error(`GitHub Project ${projectNumber} was not found for org ${org}.`);
    error.statusCode = 404;
    throw error;
  }

  const items = normalizeProjectItems(project.items?.nodes ?? []);
  const appliedStatusFilter = normalizeStatusFilter(status);
  const statusCounts = summarizeStatusCounts(items);
  const filteredItems = items.filter((item) => appliedStatusFilter === 'all' || item.status === appliedStatusFilter);
  const sortedItems = filteredItems.sort(compareProjectItems);
  const responseItemLimit = clampResponseItemLimit(limit);

  return {
    id: project.id,
    title: project.title,
    url: project.url,
    closed: Boolean(project.closed),
    totalCount: items.length,
    matchingCount: sortedItems.length,
    appliedStatusFilter,
    statusCounts,
    lanes: buildDashboardLanes(items),
    items: sortedItems.slice(0, responseItemLimit)
  };
}

function buildDashboardLanes(items) {
  return [
    {
      key: 'todo',
      label: 'Todo',
      count: items.filter((item) => item.status === 'Todo').length,
      items: items.filter((item) => item.status === 'Todo').sort(compareProjectItems).slice(0, DASHBOARD_LANE_ITEM_LIMIT)
    },
    {
      key: 'in_progress',
      label: 'In progress',
      count: items.filter((item) => item.status === 'In progress').length,
      items: items.filter((item) => item.status === 'In progress').sort(compareProjectItems).slice(0, DASHBOARD_LANE_ITEM_LIMIT)
    },
    {
      key: 'done',
      label: 'Done',
      count: items.filter((item) => item.status === 'Done').length,
      items: items.filter((item) => item.status === 'Done').sort(compareProjectItems).slice(0, DASHBOARD_LANE_ITEM_LIMIT)
    }
  ];
}

function normalizeProjectItems(nodes) {
  return nodes.map((node) => {
    const fieldMap = extractFieldMap(node.fieldValues?.nodes ?? []);
    const content = node.content ?? null;

    return {
      id: node.id,
      title: fieldMap[FIELD_NAMES.title] ?? content?.title ?? 'Untitled project item',
      url: content?.url ?? null,
      type: content?.__typename ?? 'ProjectItem',
      contentState: content?.state ?? null,
      status: fieldMap[FIELD_NAMES.status] ?? null,
      priority: fieldMap[FIELD_NAMES.priority] ?? null,
      driver: fieldMap[FIELD_NAMES.driver] ?? null,
      notes: fieldMap[FIELD_NAMES.notes] ?? null,
      targetDate: fieldMap[FIELD_NAMES.targetDate] ?? null,
      iteration: fieldMap[FIELD_NAMES.iteration] ?? null,
      size: fieldMap[FIELD_NAMES.size] ?? null
    };
  });
}

function extractFieldMap(nodes) {
  const fields = {};

  for (const node of nodes) {
    const fieldName = node.field?.name;

    if (!fieldName) {
      continue;
    }

    switch (node.__typename) {
      case 'ProjectV2ItemFieldSingleSelectValue':
        fields[fieldName] = node.name ?? null;
        break;
      case 'ProjectV2ItemFieldTextValue':
        fields[fieldName] = node.text ?? null;
        break;
      case 'ProjectV2ItemFieldDateValue':
        fields[fieldName] = node.date ?? null;
        break;
      case 'ProjectV2ItemFieldIterationValue':
        fields[fieldName] = node.title ?? null;
        break;
      default:
        break;
    }
  }

  return fields;
}

function summarizeStatusCounts(items) {
  const summary = {
    Todo: 0,
    'In progress': 0,
    Done: 0,
    Other: 0
  };

  for (const item of items) {
    if (item.status === 'Todo') {
      summary.Todo += 1;
    } else if (item.status === 'In progress') {
      summary['In progress'] += 1;
    } else if (item.status === 'Done') {
      summary.Done += 1;
    } else {
      summary.Other += 1;
    }
  }

  return summary;
}

function compareProjectItems(left, right) {
  const statusOrder = getStatusSortOrder(left.status) - getStatusSortOrder(right.status);

  if (statusOrder !== 0) {
    return statusOrder;
  }

  const priorityOrder = getPrioritySortOrder(left.priority) - getPrioritySortOrder(right.priority);

  if (priorityOrder !== 0) {
    return priorityOrder;
  }

  if (left.targetDate && right.targetDate) {
    return left.targetDate.localeCompare(right.targetDate);
  }

  if (left.targetDate) {
    return -1;
  }

  if (right.targetDate) {
    return 1;
  }

  return left.title.localeCompare(right.title);
}

function getStatusSortOrder(status) {
  switch (status) {
    case 'In progress':
      return 0;
    case 'Todo':
      return 1;
    case 'Done':
      return 2;
    default:
      return 3;
  }
}

function getPrioritySortOrder(priority) {
  switch (priority) {
    case 'P0':
      return 0;
    case 'P1':
      return 1;
    case 'P2':
      return 2;
    default:
      return 3;
  }
}

function normalizeStatusFilter(value) {
  switch (value) {
    case 'todo':
    case 'Todo':
      return 'Todo';
    case 'in_progress':
    case 'in progress':
    case 'In progress':
      return 'In progress';
    case 'done':
    case 'Done':
      return 'Done';
    default:
      return 'all';
  }
}

function clampResponseItemLimit(value) {
  if (!Number.isInteger(value)) {
    return DEFAULT_RESPONSE_ITEM_LIMIT;
  }

  return Math.max(1, Math.min(MAX_RESPONSE_ITEM_LIMIT, value));
}

async function executeGitHubGraphql({ token, query, variables, fetchImpl }) {
  const response = await fetchImpl(GITHUB_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'veloracss-tracker'
    },
    body: JSON.stringify({
      query,
      variables
    })
  });

  const payload = await response.json();

  if (!response.ok) {
    const error = new Error(payload.message ?? `GitHub API request failed with ${response.status}.`);
    error.statusCode = response.status;
    throw error;
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const error = new Error(payload.errors[0]?.message ?? 'GitHub GraphQL request failed.');
    error.statusCode = 502;
    throw error;
  }

  return payload;
}

function createConfigurationError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  return error;
}