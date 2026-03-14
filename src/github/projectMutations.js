const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
const PROJECT_FIELDS_FIRST = 20;
const PROJECT_ITEMS_FIRST = 50;
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

const PROJECT_EDITOR_QUERY = `query ProjectEditor($org: String!, $number: Int!, $itemsFirst: Int!, $fieldsFirst: Int!) {
  organization(login: $org) {
    projectV2(number: $number) {
      id
      title
      url
      fields(first: $fieldsFirst) {
        nodes {
          __typename
          ... on ProjectV2Field {
            id
            name
            dataType
          }
          ... on ProjectV2SingleSelectField {
            id
            name
            dataType
            options {
              id
              name
            }
          }
          ... on ProjectV2IterationField {
            id
            name
            dataType
            configuration {
              iterations {
                id
                title
              }
            }
          }
        }
      }
      items(first: $itemsFirst) {
        nodes {
          id
          content {
            __typename
            ... on DraftIssue {
              id
              title
              body
            }
            ... on Issue {
              id
              title
              url
              state
            }
            ... on PullRequest {
              id
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
                optionId
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
                iterationId
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

const ADD_PROJECT_DRAFT_ISSUE_MUTATION = `mutation AddProjectDraftIssue($projectId: ID!, $title: String!, $body: String) {
  addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) {
    projectItem {
      id
      content {
        __typename
        ... on DraftIssue {
          id
          title
          body
        }
      }
    }
  }
}`;

const UPDATE_PROJECT_FIELD_MUTATION = `mutation UpdateProjectField($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) {
    projectV2Item {
      id
    }
  }
}`;

const CLEAR_PROJECT_FIELD_MUTATION = `mutation ClearProjectField($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) {
    projectV2Item {
      id
    }
  }
}`;

const UPDATE_PROJECT_DRAFT_ISSUE_MUTATION = `mutation UpdateProjectDraftIssue($draftIssueId: ID!, $title: String, $body: String) {
  updateProjectV2DraftIssue(input: { draftIssueId: $draftIssueId, title: $title, body: $body }) {
    draftIssue {
      id
      title
      body
    }
  }
}`;

const DELETE_PROJECT_ITEM_MUTATION = `mutation DeleteProjectItem($projectId: ID!, $itemId: ID!) {
  deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
    deletedItemId
  }
}`;

export async function fetchGitHubProjectEditorData({ token, org, projectNumber, status = 'all', fetchImpl = fetch }) {
  validateConfiguration({ token, org, projectNumber });

  const payload = await executeGitHubGraphql({
    token,
    query: PROJECT_EDITOR_QUERY,
    variables: {
      org,
      number: projectNumber,
      itemsFirst: PROJECT_ITEMS_FIRST,
      fieldsFirst: PROJECT_FIELDS_FIRST
    },
    fetchImpl
  });

  const project = payload.data?.organization?.projectV2;

  if (!project) {
    throw createConfigurationError(`GitHub Project ${projectNumber} was not found for org ${org}.`, 404);
  }

  const fields = normalizeProjectFields(project.fields?.nodes ?? []);
  const allItems = normalizeProjectItems(project.items?.nodes ?? []);
  const normalizedStatus = normalizeStatusFilter(status);
  const filteredItems = allItems.filter((item) => normalizedStatus === 'all' || item.status === normalizedStatus);
  const sortedItems = filteredItems.sort(compareProjectItems);

  return {
    projectId: project.id,
    title: project.title,
    url: project.url,
    appliedStatusFilter: normalizedStatus,
    fields,
    allItems,
    items: sortedItems.slice(0, 25)
  };
}

export async function createProjectDraftItem({ token, projectId, fields, input, fetchImpl = fetch }) {
  const title = normalizeRequiredString(input.title, 'A title is required to create a GitHub Project draft item.');
  const body = normalizeOptionalString(input.notes);

  const payload = await executeGitHubGraphql({
    token,
    query: ADD_PROJECT_DRAFT_ISSUE_MUTATION,
    variables: {
      projectId,
      title,
      body
    },
    fetchImpl
  });

  const projectItem = payload.data?.addProjectV2DraftIssue?.projectItem;

  if (!projectItem?.id) {
    throw createConfigurationError('GitHub did not return the newly created project item.', 502);
  }

  await applyProjectFieldUpdates({
    token,
    projectId,
    itemId: projectItem.id,
    fields,
    updates: {
      status: normalizeOptionalString(input.status),
      priority: normalizeOptionalString(input.priority),
      driver: normalizeOptionalString(input.driver),
      notes: normalizeOptionalString(input.notes),
      targetDate: normalizeOptionalString(input.targetDate)
    },
    fetchImpl
  });

  return {
    itemId: projectItem.id,
    draftIssueId: projectItem.content?.id ?? null
  };
}

export async function updateProjectItemFields({ token, projectId, itemId, fields, updates, fetchImpl = fetch }) {
  return applyProjectFieldUpdates({ token, projectId, itemId, fields, updates, fetchImpl });
}

export async function updateProjectDraftItem({ token, draftIssueId, title, notes, fetchImpl = fetch }) {
  await executeGitHubGraphql({
    token,
    query: UPDATE_PROJECT_DRAFT_ISSUE_MUTATION,
    variables: {
      draftIssueId,
      title: normalizeOptionalString(title),
      body: normalizeOptionalString(notes)
    },
    fetchImpl
  });
}

export async function deleteProjectItem({ token, projectId, itemId, fetchImpl = fetch }) {
  await executeGitHubGraphql({
    token,
    query: DELETE_PROJECT_ITEM_MUTATION,
    variables: {
      projectId,
      itemId
    },
    fetchImpl
  });
}

async function applyProjectFieldUpdates({ token, projectId, itemId, fields, updates, fetchImpl }) {
  const entries = [
    ['status', updates.status],
    ['priority', updates.priority],
    ['driver', updates.driver],
    ['notes', updates.notes],
    ['targetDate', updates.targetDate]
  ];

  for (const [key, value] of entries) {
    if (!(key in fields)) {
      continue;
    }

    const field = fields[key];

    if (value === undefined) {
      continue;
    }

    if (value === null || value === '') {
      await clearProjectFieldValue({ token, projectId, itemId, fieldId: field.id, fetchImpl });
      continue;
    }

    const fieldValue = buildFieldValue(field, value);
    await executeGitHubGraphql({
      token,
      query: UPDATE_PROJECT_FIELD_MUTATION,
      variables: {
        projectId,
        itemId,
        fieldId: field.id,
        value: fieldValue
      },
      fetchImpl
    });
  }
}

async function clearProjectFieldValue({ token, projectId, itemId, fieldId, fetchImpl }) {
  await executeGitHubGraphql({
    token,
    query: CLEAR_PROJECT_FIELD_MUTATION,
    variables: {
      projectId,
      itemId,
      fieldId
    },
    fetchImpl
  });
}

function buildFieldValue(field, value) {
  switch (field.dataType) {
    case 'SINGLE_SELECT': {
      const normalizedValue = resolveSingleSelectFieldValue(field, value);
      const optionId = field.optionsByName.get(normalizedValue) ?? null;

      if (!optionId) {
        const availableOptions = field.options.map((option) => option.name).join(', ');
        const availableOptionsSuffix = availableOptions.length > 0 ? ` Available options: ${availableOptions}.` : '';
        throw createConfigurationError(`The ${field.name} option "${value}" does not exist on this GitHub Project.${availableOptionsSuffix}`);
      }

      return {
        singleSelectOptionId: optionId
      };
    }
    case 'TEXT':
      return {
        text: value
      };
    case 'DATE':
      return {
        date: value
      };
    default:
      throw createConfigurationError(`The tracker cannot write the ${field.name} field yet.`);
  }
}

function normalizeProjectFields(nodes) {
  const fields = {};

  for (const node of nodes) {
    switch (node.name) {
      case FIELD_NAMES.status:
        fields.status = createSingleSelectField('status', node);
        break;
      case FIELD_NAMES.priority:
        fields.priority = createSingleSelectField('priority', node);
        break;
      case FIELD_NAMES.driver:
        fields.driver = createWritableField('driver', node);
        break;
      case FIELD_NAMES.notes:
        fields.notes = createWritableField('notes', node);
        break;
      case FIELD_NAMES.targetDate:
        fields.targetDate = createWritableField('targetDate', node);
        break;
      case FIELD_NAMES.iteration:
        fields.iteration = createIterationField('iteration', node);
        break;
      case FIELD_NAMES.size:
        fields.size = createSingleSelectField('size', node, true);
        break;
      default:
        break;
    }
  }

  return fields;
}

function createCommonField(key, node) {
  return {
    key,
    id: node.id,
    name: node.name,
    dataType: node.dataType
  };
}

function createWritableField(key, node) {
  if (node.dataType === 'SINGLE_SELECT') {
    return createSingleSelectField(key, node);
  }

  return createCommonField(key, node);
}

function resolveSingleSelectFieldValue(field, value) {
  const normalizedValue = value.toLowerCase();

  if (field.optionsByName.has(normalizedValue)) {
    return normalizedValue;
  }

  if (field.key === 'driver' && field.optionsByName.has('user')) {
    return 'user';
  }

  return normalizedValue;
}

function createSingleSelectField(key, node, optional = false) {
  if (node.__typename !== 'ProjectV2SingleSelectField') {
    if (optional) {
      return {
        key,
        id: node.id,
        name: node.name,
        dataType: node.dataType,
        options: [],
        optionsByName: new Map()
      };
    }

    throw createConfigurationError(`GitHub Project field ${node.name} is not a single-select field.`);
  }

  return {
    key,
    id: node.id,
    name: node.name,
    dataType: node.dataType,
    options: node.options ?? [],
    optionsByName: new Map((node.options ?? []).map((option) => [option.name.toLowerCase(), option.id]))
  };
}

function createIterationField(key, node) {
  return {
    key,
    id: node.id,
    name: node.name,
    dataType: node.dataType,
    iterations: node.configuration?.iterations ?? []
  };
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
      contentId: content?.id ?? null,
      contentState: content?.state ?? null,
      body: content?.body ?? null,
      status: fieldMap[FIELD_NAMES.status] ?? null,
      priority: fieldMap[FIELD_NAMES.priority] ?? null,
      driver: fieldMap[FIELD_NAMES.driver] ?? null,
      notes: fieldMap[FIELD_NAMES.notes] ?? null,
      targetDate: fieldMap[FIELD_NAMES.targetDate] ?? null,
      iteration: fieldMap[FIELD_NAMES.iteration] ?? null,
      size: fieldMap[FIELD_NAMES.size] ?? null,
      optionIds: {
        status: fieldMap.__optionIds?.status ?? null,
        priority: fieldMap.__optionIds?.priority ?? null
      }
    };
  });
}

function extractFieldMap(nodes) {
  const fields = {
    __optionIds: {}
  };

  for (const node of nodes) {
    const fieldName = node.field?.name;

    if (!fieldName) {
      continue;
    }

    switch (node.__typename) {
      case 'ProjectV2ItemFieldSingleSelectValue':
        fields[fieldName] = node.name ?? null;
        if (fieldName === FIELD_NAMES.status) {
          fields.__optionIds.status = node.optionId ?? null;
        }
        if (fieldName === FIELD_NAMES.priority) {
          fields.__optionIds.priority = node.optionId ?? null;
        }
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
    throw createConfigurationError(payload.message ?? `GitHub API request failed with ${response.status}.`, response.status);
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw createConfigurationError(payload.errors[0]?.message ?? 'GitHub GraphQL request failed.', 502);
  }

  return payload;
}

function validateConfiguration({ token, org, projectNumber }) {
  if (!token) {
    throw createConfigurationError('GITHUB_TOKEN is required before the tracker can write GitHub Projects.');
  }

  if (!org) {
    throw createConfigurationError('GITHUB_ORG is required before the tracker can write GitHub Projects.');
  }

  if (!Number.isInteger(projectNumber)) {
    throw createConfigurationError('GITHUB_PROJECT_NUMBER must be set to the target GitHub Project number.');
  }
}

function normalizeRequiredString(value, message) {
  const normalized = normalizeOptionalString(value);

  if (!normalized) {
    throw createConfigurationError(message);
  }

  return normalized;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function createConfigurationError(message, statusCode = 503) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}