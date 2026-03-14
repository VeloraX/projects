import { createHash } from 'node:crypto';

const EMPTY_FIELDS = Object.freeze({
  title: null,
  status: null,
  priority: null,
  driver: null,
  notes: null,
  targetDate: null,
  iteration: null
});

export function normalizeGitHubWebhook({ eventName, deliveryId, payload, receivedAt = new Date().toISOString() }) {
  const fields = extractFields(payload);

  return {
    deliveryId,
    type: eventName,
    action: pickFirstString(payload.action, payload.projects_v2_item?.action),
    receivedAt,
    github: {
      projectId: pickFirstString(
        payload.projects_v2?.node_id,
        payload.project_v2?.node_id,
        payload.project?.node_id
      ),
      projectItemId: pickFirstString(
        payload.projects_v2_item?.node_id,
        payload.project_v2_item?.node_id,
        payload.project_item?.node_id,
        payload.item?.node_id
      ),
      contentId: pickFirstString(
        payload.projects_v2_item?.content?.node_id,
        payload.project_v2_item?.content?.node_id,
        payload.content?.node_id,
        payload.issue?.node_id,
        payload.pull_request?.node_id
      )
    },
    fields,
    snapshotHash: createHash('sha256').update(JSON.stringify(fields)).digest('hex')
  };
}

function extractFields(payload) {
  const fields = {
    ...EMPTY_FIELDS,
    title: pickFirstString(
      payload.projects_v2_item?.content?.title,
      payload.project_v2_item?.content?.title,
      payload.issue?.title,
      payload.pull_request?.title,
      payload.title
    )
  };

  for (const fieldValue of collectFieldValues(payload)) {
    const fieldName = getFieldName(fieldValue);
    const scalarValue = getFieldScalarValue(fieldValue);

    if (!fieldName || scalarValue === null) {
      continue;
    }

    switch (fieldName.toLowerCase()) {
      case 'status':
        fields.status = scalarValue;
        break;
      case 'priority':
        fields.priority = scalarValue;
        break;
      case 'driver':
      case 'owner':
        fields.driver = scalarValue;
        break;
      case 'notes':
        fields.notes = scalarValue;
        break;
      case 'target date':
      case 'target-date':
        fields.targetDate = scalarValue;
        break;
      case 'iteration':
        fields.iteration = scalarValue;
        break;
      default:
        break;
    }
  }

  return fields;
}

function collectFieldValues(payload) {
  const candidates = [
    payload.projects_v2_item?.field_values,
    payload.projects_v2_item?.fieldValues,
    payload.project_v2_item?.field_values,
    payload.project_v2_item?.fieldValues,
    payload.field_values,
    payload.fieldValues
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function getFieldName(fieldValue) {
  return pickFirstString(
    fieldValue.field?.name,
    fieldValue.fieldValue?.field?.name,
    fieldValue.name
  );
}

function getFieldScalarValue(fieldValue) {
  const stringValue = pickFirstString(
    fieldValue.text,
    fieldValue.value,
    fieldValue.note,
    fieldValue.body,
    fieldValue.date,
    fieldValue.option?.name,
    fieldValue.field_option?.name,
    fieldValue.single_select_option?.name,
    fieldValue.iteration?.title,
    fieldValue.user?.login,
    fieldValue.assignee?.login
  );

  if (stringValue !== null) {
    return stringValue;
  }

  if (typeof fieldValue.number === 'number') {
    return String(fieldValue.number);
  }

  return null;
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const normalized = value.trim();

      if (normalized.length > 0) {
        return normalized;
      }
    }
  }

  return null;
}
