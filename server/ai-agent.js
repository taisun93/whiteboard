/**
 * LangChain + OpenAI 4o agent for whiteboard commands.
 * Returns tool calls for the server to execute (mutate state + broadcast).
 * Requires OPENAI_API_KEY in .env.
 */
const { z } = require('zod');
const { ChatOpenAI } = require('@langchain/openai');
const { DynamicStructuredTool } = require('@langchain/core/tools');
const { HumanMessage, ToolMessage } = require('@langchain/core/messages');

function getModel() {
  return new ChatOpenAI({
    modelName: 'gpt-4o',
    temperature: 0.2
  });
}

const tools = [
  new DynamicStructuredTool({
    name: 'createStickyNote',
    description: 'Create a sticky note on the board. Use for notes, labels, or reminders.',
    schema: z.object({
      text: z.string().describe('Text content of the sticky note'),
      x: z.number().describe('X position in world coordinates'),
      y: z.number().describe('Y position in world coordinates'),
      color: z.string().optional().describe('Hex color e.g. #fef9c3 (default yellow)')
    }),
    func: async () => 'Tool will be executed by server.'
  }),
  new DynamicStructuredTool({
    name: 'createShape',
    description: 'Create a rectangle or circle shape on the board.',
    schema: z.object({
      type: z.enum(['rect', 'circle']).describe('Shape type'),
      x: z.number(),
      y: z.number(),
      width: z.number().describe('Width of the shape'),
      height: z.number().describe('Height of the shape'),
      color: z.string().optional()
    }),
    func: async () => 'Tool will be executed by server.'
  }),
  new DynamicStructuredTool({
    name: 'createFrame',
    description: 'Create a frame (container/group) on the board with an optional title.',
    schema: z.object({
      title: z.string().optional().describe('Frame title'),
      x: z.number(),
      y: z.number(),
      width: z.number().optional(),
      height: z.number().optional()
    }),
    func: async () => 'Tool will be executed by server.'
  }),
  new DynamicStructuredTool({
    name: 'createQuadrantTemplate',
    description: 'Create a 2x2 quadrant template: four frames in a grid. Use for SWOT analysis (Strengths, Weaknesses, Opportunities, Threats), four quadrants, 2x2 matrix, or any four-section layout. Order: title1=top-left, title2=top-right, title3=bottom-left, title4=bottom-right.',
    schema: z.object({
      title1: z.string().describe('Top-left quadrant title (e.g. Strengths for SWOT)'),
      title2: z.string().describe('Top-right quadrant title (e.g. Weaknesses for SWOT)'),
      title3: z.string().describe('Bottom-left quadrant title (e.g. Opportunities for SWOT)'),
      title4: z.string().describe('Bottom-right quadrant title (e.g. Threats for SWOT)'),
      x: z.number().describe('X position of top-left of the grid (world coordinates)'),
      y: z.number().describe('Y position of top-left of the grid (world coordinates)'),
      width: z.number().optional().describe('Width of each frame (default 280)'),
      height: z.number().optional().describe('Height of each frame (default 200)'),
      gap: z.number().optional().describe('Gap between frames (default 16)')
    }),
    func: async () => 'Tool will be executed by server.'
  }),
  new DynamicStructuredTool({
    name: 'createConnector',
    description: 'Create an arrow/connector between two objects. fromId and toId can be sticky id, text element id, stroke id, or a point as "x,y".',
    schema: z.object({
      fromId: z.string().describe('ID of source object or "x,y" for a point'),
      toId: z.string().describe('ID of target object or "x,y" for a point'),
      style: z.string().optional().describe('Hex color for the arrow')
    }),
    func: async () => 'Tool will be executed by server.'
  }),
  new DynamicStructuredTool({
    name: 'moveObject',
    description: 'Move an existing object (sticky, text, frame, or stroke) by id to new x,y.',
    schema: z.object({
      objectId: z.string().describe('ID of the object to move'),
      x: z.number(),
      y: z.number()
    }),
    func: async () => 'Tool will be executed by server.'
  }),
  new DynamicStructuredTool({
    name: 'resizeObject',
    description: 'Resize an object by id (sticky, text, frame, or shape stroke).',
    schema: z.object({
      objectId: z.string(),
      width: z.number(),
      height: z.number()
    }),
    func: async () => 'Tool will be executed by server.'
  }),
  new DynamicStructuredTool({
    name: 'updateText',
    description: 'Update the text content of a sticky note or text element.',
    schema: z.object({
      objectId: z.string(),
      newText: z.string()
    }),
    func: async () => 'Tool will be executed by server.'
  }),
  new DynamicStructuredTool({
    name: 'changeColor',
    description: 'Change the color of a sticky, text element, stroke, or connector.',
    schema: z.object({
      objectId: z.string(),
      color: z.string().describe('Hex color e.g. #3b82f6')
    }),
    func: async () => 'Tool will be executed by server.'
  }),
  new DynamicStructuredTool({
    name: 'getBoardState',
    description: 'Get the current board state with full details: stickies (id, x, y, width, height, text, color), strokes (strokeId, shape, color, points), textElements (id, x, y, width, height, text, color), frames (id, x, y, width, height, title), connectors (id, from, to, color). Use this to see existing IDs, colors, and positions before moving, resizing, changing colors, or connecting.',
    schema: z.object({}),
    func: async () => 'Tool will be executed by server.'
  }),
  new DynamicStructuredTool({
    name: 'centerView',
    description: 'Center the user\'s view on a point and optionally set zoom. Use after creating or moving something so the user sees it. Coordinates are in world units (same as the board).',
    schema: z.object({
      x: z.number().describe('World X to center the view on'),
      y: z.number().describe('World Y to center the view on'),
      zoom: z.number().optional().describe('Optional zoom level (e.g. 1 = 100%, 2 = 200%). Omit to keep current zoom.')
    }),
    func: async () => 'View will be centered by the client.'
  })
];

function getBoundModel() {
  return getModel().bindTools(tools);
}

const SYSTEM_PROMPT = `You are an assistant that helps users edit a shared whiteboard. The user will give you a natural language command. Use the available tools to change the board. Coordinates and sizes are in world units (e.g. 100, 200). When creating objects, use reasonable positions (e.g. 50-400 for x,y).

Templates and multi-item layouts:
- When the user asks for a "SWOT analysis", "four quadrants", "2x2 matrix", "quadrant template", or similar, use createQuadrantTemplate exactly once with four titles. For SWOT use: title1="Strengths", title2="Weaknesses", title3="Opportunities", title4="Threats" (in that order). Use a single createQuadrantTemplate call; do not create four separate frames.
- When the user asks for a "template" with multiple sections, quadrants, or a matrix, prefer createQuadrantTemplate if there are four sections; otherwise create the right number of frames or stickies with createFrame/createStickyNote, spaced in a clear grid (e.g. 20-30 units apart).

If the user asks to move, resize, update, or connect something, call getBoardState first to see current objects and their IDs, then call the appropriate mutation tool. When you receive the result of getBoardState, use the exact IDs from that data. For createConnector, fromId and toId can be: a sticky id, a text element id, a stroke id, or a point as "x,y" (e.g. "100,200"). Use centerView(x, y, zoom?) to pan and zoom the user's view to a spot after creating content so they can see it. Reply briefly to the user after you are done.`;

const MAX_AGENT_TURNS = 6;

/**
 * @param {string} command - User's natural language command
 * @param {string} boardStateJson - JSON string of current board state (stickies, strokes, textElements, frames, connectors) for context
 * @returns {Promise<{ message: string, toolCalls: Array<{ id: string, name: string, args: object }> }>}
 */
async function runAiCommand(command, boardStateJson) {
  const stateSummary = boardStateJson
    ? `Current board state summary (call getBoardState to get full IDs and details):\n${boardStateJson.slice(0, 4000)}`
    : 'Board state not provided. Call getBoardState to see the board.';

  const userContent = `${stateSummary}\n\nUser command: ${command}`;
  let messages = [
    new HumanMessage({ content: SYSTEM_PROMPT }),
    new HumanMessage({ content: userContent })
  ];

  const allMutationCalls = [];
  let viewCenter = null;
  let lastResponse;
  let turns = 0;

  while (turns < MAX_AGENT_TURNS) {
    turns++;
    lastResponse = await getBoundModel().invoke(messages);

    if (!lastResponse.tool_calls || lastResponse.tool_calls.length === 0) {
      break;
    }

    messages.push(lastResponse);

    const toolResults = [];
    for (const tc of lastResponse.tool_calls) {
      const name = tc.name || '';
      const args = tc.args || {};
      if (name === 'getBoardState') {
        toolResults.push(new ToolMessage({
          content: boardStateJson || '{}',
          tool_call_id: tc.id
        }));
      } else if (name === 'centerView') {
        viewCenter = { x: args.x, y: args.y };
        if (typeof args.zoom === 'number') viewCenter.zoom = args.zoom;
        toolResults.push(new ToolMessage({
          content: 'View will be centered by the client.',
          tool_call_id: tc.id
        }));
      } else {
        allMutationCalls.push({ id: tc.id, name, args });
        toolResults.push(new ToolMessage({
          content: 'Queued for execution.',
          tool_call_id: tc.id
        }));
      }
    }
    messages.push(...toolResults);
  }

  const message = typeof lastResponse.content === 'string'
    ? lastResponse.content
    : (Array.isArray(lastResponse.content) ? lastResponse.content.map(c => c.text || '').join('') : '');

  return { message: message.trim() || 'Done.', toolCalls: allMutationCalls, viewCenter };
}

module.exports = { runAiCommand };
