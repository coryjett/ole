// Ole: shared types for the Ole additions to Yogurt.

export type SecretName = 'openai' | `mcp:${string}`;

export type ProviderChoice = 'local' | 'openai';

export type OleProviders = {
  transcription: ProviderChoice;
  assistant: ProviderChoice;
  openaiTranscribeModel: string;
  /** live bullets and summaries: fast */
  openaiChatModel: string;
  /** the pre-call briefing: picks tools and writes, so a larger model */
  openaiPrepareModel: string;
  /** the person's own instructions for the pre-call warm-up (which tools, what matters, the format); '' for none */
  warmupInstructions: string;
};

/** an MCP server the person added in Settings; its key is the secret `mcp:<id>` */
export type McpServerConfig = { id: string; name: string; url: string; enabled: boolean };

export type OleBullet = { id: string; text: string; source: string; at: number };

/** a tool offered to the model: name is the OpenAI function name (`<serverId>__<tool>`, [A-Za-z0-9_-], max 64) */
export type OleTool = { name: string; serverId: string; serverName: string; tool: string; description: string; parameters: Record<string, unknown> };

export type PreparedContext = {
  meetingTitle: string | null;
  /** what the person asked to prepare for (a company, person or topic); null: the meeting alone */
  focus: string | null;
  text: string;
  preparedAt: number;
};
