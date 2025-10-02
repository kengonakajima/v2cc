import { createHash } from 'crypto';

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'echo_text',
    description: 'Echo the provided text back to the user. Useful for confirming what was heard.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text that should be repeated back to the user.',
        },
        correlation_id: {
          type: 'string',
          description: 'Optional identifier used to correlate tool calls with external events.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'weather',
    description: 'Return the latest weather summary for the requested location.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City or region to check. Optional; defaults to current location context.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'addTodo',
    description: 'Add a new TODO item with the provided description.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: '内容を表す説明文。',
        },
      },
      required: ['description'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'delTodo',
    description: 'Delete a TODO item by id.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'integer',
          description: '削除対象の TODO ID。',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'updateTodo',
    description: 'Update the description text of a TODO item.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'integer',
          description: '更新対象の TODO ID。',
        },
        description: {
          type: 'string',
          description: '新しい説明文。',
        },
      },
      required: ['id', 'description'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'setDone',
    description: 'Update the done status of a TODO item.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'integer',
          description: '対象の TODO ID。',
        },
        done: {
          type: 'boolean',
          description: '完了状態。true で完了。',
        },
      },
      required: ['id', 'done'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'listTodo',
    description: 'List all TODO items currently stored.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

const TOOL_HANDLERS = {
  async echo_text(args = {}, context = {}) {
    const text = typeof args.text === 'string' ? args.text : '';
    const correlation = deriveCorrelation(args.correlation_id, context);
    return {
      echoed_text: text,
      correlation,
      received_at: new Date().toISOString(),
    };
  },
  async weather(args = {}) {
    const location = typeof args.location === 'string' && args.location.trim() ? args.location.trim() : null;
    return {
      forecast: '雨時々晴れ',
      location: location ?? '現在地',
      issued_at: new Date().toISOString(),
    };
  },
  async addTodo(args = {}, context = {}) {
    const api = resolveTodoApi(context);
    if (!api) {
      return { error: 'todo manager unavailable' };
    }
    const description = typeof args.description === 'string' ? args.description : '';
    return api.add(description).then((todo) => {
      if (!todo) {
        return { error: 'failed to add todo' };
      }
      return { todo };
    });
  },
  async delTodo(args = {}, context = {}) {
    const api = resolveTodoApi(context);
    if (!api) {
      return { error: 'todo manager unavailable' };
    }
    const id = Number.parseInt(args.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return { error: 'invalid id' };
    }
    return api.remove(id).then((removed) => ({ success: Boolean(removed) }));
  },
  async updateTodo(args = {}, context = {}) {
    const api = resolveTodoApi(context);
    if (!api) {
      return { error: 'todo manager unavailable' };
    }
    const id = Number.parseInt(args.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return { error: 'invalid id' };
    }
    const description = typeof args.description === 'string' ? args.description : '';
    return api.update(id, description).then((todo) => {
      if (!todo) {
        return { error: 'update failed' };
      }
      return { todo };
    });
  },
  async setDone(args = {}, context = {}) {
    const api = resolveTodoApi(context);
    if (!api) {
      return { error: 'todo manager unavailable' };
    }
    const id = Number.parseInt(args.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return { error: 'invalid id' };
    }
    const done = Boolean(args.done);
    return api.setDone(id, done).then((todo) => {
      if (!todo) {
        return { error: 'setDone failed' };
      }
      return { todo };
    });
  },
  async listTodo(_args = {}, context = {}) {
    const api = resolveTodoApi(context);
    if (!api) {
      return { error: 'todo manager unavailable' };
    }
    return api.list().then((todos) => ({ todos }));
  },
};

export function getToolDefinitions() {
  return TOOL_DEFINITIONS;
}

export async function routeToolCall(call, context = {}) {
  const handler = TOOL_HANDLERS[call.name];
  if (!handler) {
    return {
      call_id: call.call_id,
      output: JSON.stringify({
        error: `Unsupported tool name: ${call.name}`,
      }),
    };
  }

  const rawArgs = call.arguments ?? '{}';
  const parsedArgs = JSON.parse(rawArgs);
  const result = await handler(parsedArgs, context);
  return {
    call_id: call.call_id,
    output: JSON.stringify(result ?? {}),
  };
}

function resolveTodoApi(context) {
  if (!context || typeof context !== 'object') {
    return null;
  }
  const api = context.todoApi;
  if (!api || typeof api !== 'object') {
    return null;
  }
  const hasMethods = typeof api.list === 'function' && typeof api.add === 'function' && typeof api.remove === 'function' && typeof api.update === 'function' && typeof api.setDone === 'function';
  if (!hasMethods) {
    return null;
  }
  return api;
}

function deriveCorrelation(toolCorrelationId, context) {
  if (typeof toolCorrelationId === 'string' && toolCorrelationId) {
    return toolCorrelationId;
  }
  if (!context || typeof context !== 'object') {
    return null;
  }
  const transcript = typeof context.userText === 'string' ? context.userText : '';
  if (!transcript) {
    return null;
  }
  const hash = createHash('sha1');
  hash.update(transcript);
  return hash.digest('hex').slice(0, 12);
}
