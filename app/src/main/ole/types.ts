// Ole: shared types for the Ole additions to Yogurt.

export type SecretName = 'openai' | 'custom' | `mcp:${string}`;

export type ProviderChoice = 'local' | 'openai';

/** who writes: on the Mac, OpenAI, or any OpenAI-compatible server the person runs (#17) */
export type AssistantChoice = ProviderChoice | 'custom';

export type OleProviders = {
  transcription: ProviderChoice;
  assistant: AssistantChoice;
  openaiTranscribeModel: string;
  /** live bullets and summaries: fast */
  openaiChatModel: string;
  /** the pre-call briefing: picks tools and writes, so a larger model */
  openaiPrepareModel: string;
  /** the person's own instructions for the pre-call warm-up (which tools, what matters, the format); '' for none */
  warmupInstructions: string;
  /** the Custom server's OpenAI-compatible base URL (https, ends at /v1); '' until set (#17) */
  customBaseUrl: string;
  /** the model asked of the Custom server for Prepare, bullets and summaries */
  customModel: string;
  /** where Prepare runs: with the Assistant (OpenAI or Custom server), or on the Mac's own model (#5); live bullets never run locally */
  prepareOn: 'assistant' | 'local';
};

/** an MCP server the person added in Settings; its key is the secret `mcp:<id>` */
export type McpServerConfig = { id: string; name: string; url: string; enabled: boolean };

/** heard: the words from the call it answers; quote: a short excerpt of its source (#39). Both checked against what Ole has. */
export type OleBullet = { id: string; text: string; source: string; at: number; heard?: string; quote?: string };

/** a tool offered to the model: name is the OpenAI function name (`<serverId>__<tool>`, [A-Za-z0-9_-], max 64) */
export type OleTool = { name: string; serverId: string; serverName: string; tool: string; description: string; parameters: Record<string, unknown> };

export type PreparedContext = {
  meetingTitle: string | null;
  /** what the person asked to prepare for (a company, person or topic); null: the meeting alone */
  focus: string | null;
  text: string;
  preparedAt: number;
};
