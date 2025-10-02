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
