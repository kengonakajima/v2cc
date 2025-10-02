export async function generateOpenAIOutputs({ client, modelId, conversation, tools }) {
  const requestBody = {
    model: modelId,
    input: conversation,
    parallel_tool_calls: false,
  };

  if (Array.isArray(tools) && tools.length) {
    requestBody.tools = tools;
    requestBody.tool_choice = 'auto';
  }

  const response = await client.responses.create(requestBody);
  return dissectResponse(response);
}

function dissectResponse(response) {
  const textOutputs = [];
  const toolCalls = [];
  const items = Array.isArray(response.output) ? response.output : [];

  for (const item of items) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      const textParts = item.content
        .filter((content) => content && content.type === 'output_text')
        .map((content) => content.text)
        .filter(Boolean);
      if (textParts.length) {
        textOutputs.push(textParts.join(''));
      }
    }

    if (item.type === 'function_call') {
      toolCalls.push({
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    }
  }

  return { textOutputs, toolCalls };
}
