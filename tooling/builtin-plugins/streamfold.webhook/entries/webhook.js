'use strict';

function configuredUrl(context) {
  const value = context && context.config && context.config.url;
  if (typeof value !== 'string' || !value.startsWith('https://')) {
    throw new Error('Webhook URL is not configured');
  }
  return value;
}

function filterFields(value, fields) {
  if (!Array.isArray(fields) || fields.length === 0 || !value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const selected = {};
  for (const key of fields) {
    if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(value, key)) selected[key] = value[key];
  }
  return selected;
}

async function send(context, envelope) {
  const target = configuredUrl(context);
  const body = {
    eventId: envelope.id,
    type: envelope.type,
    schemaVersion: 1,
    occurredAt: envelope.occurredAt,
    source: envelope.source || { app: 'streamfold', pluginId: null },
    subject: envelope.subject || { accountId: context.accountId || null, contentId: null },
    data: filterFields(envelope.data || {}, context.config.fields)
  };
  try {
    const response = await streamfold.network.request(target, {
      method: 'POST',
      body,
      timeoutMs: 30000
    });
    return { status: response.status, retryAfter: response.retryAfter || null };
  } catch (_error) {
    return { status: 599, retryAfter: null };
  }
}

module.exports = {
  async handle(context, event) {
    const selectedEvents = context && context.config && context.config.events;
    if (Array.isArray(selectedEvents) && selectedEvents.length > 0 && !selectedEvents.includes(event.type)) {
      return { status: 204, skipped: true };
    }
    return send(context, event);
  },
  async run(context) {
    const accounts = await streamfold.data.read('accounts', context.accountId ? { accountId: context.accountId } : {});
    const profiles = await streamfold.data.read('profiles', context.accountId ? { accountId: context.accountId } : {});
    const scheduled = context.trigger === 'schedule';
    const data = { accounts, profiles };
    if (scheduled) {
      data.contents = await streamfold.data.read('contents', context.accountId ? { accountId: context.accountId, limit: 100 } : { limit: 100 });
      data.metrics = await streamfold.data.read('metrics', context.accountId ? { accountId: context.accountId, limit: 100 } : { limit: 100 });
    }
    const now = new Date().toISOString();
    return send(context, {
      id: context.deliveryId || ('manual-' + now),
      type: scheduled ? 'streamfold.snapshot.v1' : 'streamfold.webhook.test.v1',
      occurredAt: now,
      source: { app: 'streamfold', pluginId: 'streamfold.webhook' },
      subject: { accountId: context.accountId || null, contentId: null },
      data
    });
  }
};
