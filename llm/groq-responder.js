export async function generateGroqOutputs({ apiKey, modelId, conversation, tools }) {
  if (!apiKey) {
    throw new Error('GROQ_API_KEY が設定されていません (.env で指定してください)');
  }

  const response = await callGroqChat({
    apiKey,
    modelId,
    conversation,
    tools,
  });
  return dissectGroqResponse(response);
}

async function callGroqChat({ apiKey, modelId, conversation: items, tools }) {
  const messages = convertConversationToGroqMessages(items);
  const body = {
    model: modelId,
    messages,
  };

  if (Array.isArray(tools) && tools.length) {
    body.tools = normalizeToolsForChat(tools);
    body.tool_choice = 'auto';
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Groq API リクエスト失敗: ${response.status} ${response.statusText} ${errorText}`.trim());
  }

  return response.json();
}

function normalizeToolsForChat(tools) {
  return tools.map((tool) => {
    if (!tool || tool.type !== 'function') {
      return tool;
    }
    const parameters = adaptGroqToolParameters(tool.parameters);
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters,
      },
    };
  });
}

function adaptGroqToolParameters(schema) {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const clone = JSON.parse(JSON.stringify(schema));
  const requiredSet = new Set(Array.isArray(clone.required) ? clone.required : []);
  if (clone.properties && typeof clone.properties === 'object') {
    for (const [key, value] of Object.entries(clone.properties)) {
      if (!value || typeof value !== 'object') continue;
      if (requiredSet.has(key)) continue;
      const currentType = value.type;
      if (typeof currentType === 'string') {
        if (currentType !== 'null') {
          value.type = [currentType, 'null'];
        }
      } else if (Array.isArray(currentType) && !currentType.includes('null')) {
        value.type = [...currentType, 'null'];
      }
    }
  }
  return clone;
}

function convertConversationToGroqMessages(items) {
  const messages = [];
  for (const item of items) {
    if (!item) {
      continue;
    }
    if (item.type === 'message') {
      const role = item.role ?? 'user';
      const text = extractTextFromContent(item.content);
      messages.push({ role, content: text ?? '' });
      continue;
    }
    if (item.type === 'function_call') {
      const callId = item.call_id ?? `call_${Date.now()}`;
      const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: {
              name: item.name,
              arguments: args,
            },
          },
        ],
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: item.output ?? '',
      });
    }
  }
  return messages;
}

function extractTextFromContent(content) {
  if (!Array.isArray(content)) {
    return '';
  }
  const parts = [];
  for (const entry of content) {
    if (entry && typeof entry.text === 'string') {
      parts.push(entry.text);
    }
  }
  return parts.join('');
}

function dissectGroqResponse(response) {
  const textOutputs = [];
  const toolCalls = [];
  const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
  const message = choice?.message ?? {};

  const content = message.content;
  if (typeof content === 'string') {
    if (content.trim()) {
      textOutputs.push(content);
    }
  } else if (Array.isArray(content)) {
    const textParts = content
      .map((entry) => {
        if (!entry) return '';
        if (typeof entry === 'string') return entry;
        if (typeof entry?.text === 'string') return entry.text;
        return '';
      })
      .filter(Boolean);
    if (textParts.length) {
      textOutputs.push(textParts.join(''));
    }
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!call) continue;
      const fn = call.function ?? {};
      let args = fn.arguments;
      if (typeof args === 'object') {
        args = JSON.stringify(args);
      }
      if (typeof args !== 'string') {
        args = '{}';
      }
      toolCalls.push({
        call_id: call.id ?? `call_${Date.now()}`,
        name: fn.name ?? '',
        arguments: args,
      });
    }
  }

  if (!message.tool_calls && message.function_call) {
    const fn = message.function_call;
    const callId = fn?.name ? `call_${Date.now()}` : `call_${Date.now()}`;
    let args = fn?.arguments;
    if (typeof args === 'object') {
      args = JSON.stringify(args);
    }
    if (typeof args !== 'string') {
      args = '{}';
    }
    toolCalls.push({
      call_id: callId,
      name: fn?.name ?? '',
      arguments: args,
    });
  }

  return { textOutputs, toolCalls };
}
