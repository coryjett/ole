// Ole: shared types for the Ole additions to Yogurt.

export type SecretName = 'openai' | 'custom' | `mcp:${string}`;

export type ProviderChoice = 'local' | 'openai';

/** who writes: on the Mac, OpenAI, or any OpenAI-compatible server the person runs (#17) */
export type AssistantChoice = ProviderChoice | 'custom';

/** a retiring transcription model Ole replaced: what it was, what it is now, and the shutdown date (YYYY-MM-DD) */
export type TranscribeModelSwitch = { from: string; to: string; retires: string };

export type OleProviders = {
  transcription: ProviderChoice;
  assistant: AssistantChoice;
  openaiTranscribeModel: string;
  /** the saved transcription model was a retiring one and Ole moved it to the successor (#89); null once dismissed */
  transcribeModelSwitched: TranscribeModelSwitch | null;
  /** OpenAI transcription streams live calls over the Realtime API, falling back to chunks (#85); on unless turned off */
  openaiStreaming: boolean;
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
  /** keep Ole's windows out of screen sharing and screenshots while a call records (#51, #61); off unless turned on */
  hideWhileSharing: boolean;
  /** prepare by itself shortly before calendar meetings (#52) */
  autoPrepare: boolean;
  /** how many minutes before a meeting auto-prepare runs: 5, 10 or 15 */
  autoPrepareLead: number;
};

/** an MCP server the person added in Settings; its key is the secret `mcp:<id>` */
export type McpServerConfig = { id: string; name: string; url: string; enabled: boolean };

/** heard: the words from the call it answers; quote: a short excerpt of its source (#39). Both checked against what Ole has. */
export type OleBullet = { id: string; text: string; source: string; at: number; heard?: string; quote?: string; url?: string; pinned?: boolean; rating?: 'up' | 'down' };

/** a question asked during the call and Ole's answer (#53); pending while it is being answered */
/** ok: true only for a real answer, false for "couldn't find it" or a failure; absent on answers saved before it existed */
export type OleAnswer = { id: string; question: string; text: string; source?: string; url?: string; at: number; pending?: boolean; ok?: boolean };

/** someone on the call said they will do something (#82); who: as the call names them, '' when unclear */
export type OleCommitment = { who: string; what: string };

/** the call's running record (#75, #82): summary text, questions still open, commitments */
export type OleCallMemory = { summary: string; openQuestions: string[]; commitments: OleCommitment[] };

/** a tool offered to the model: name is the OpenAI function name (`<serverId>__<tool>`, [A-Za-z0-9_-], max 64) */
/** openWorld: the server's openWorldHint, when it gave one (#86: names only go to tools marked closed-world, or record lookups) */
export type OleTool = { name: string; serverId: string; serverName: string; tool: string; description: string; parameters: Record<string, unknown>; openWorld?: boolean };

export type PreparedContext = {
  meetingTitle: string | null;
  /** what the person asked to prepare for (a company, person or topic); null: the meeting alone */
  focus: string | null;
  text: string;
  preparedAt: number;
  /** a server's one-line note on the meeting this was prepared for (#98), with the server's name */
  note?: { text: string; source?: string };
  /** the organisations Prepare's tool results named, described when they gave an industry or size (#109) */
  orgs?: Array<{ name: string; description?: string }>;
  /** Prepare found more organisations than it kept (#116): sources replace every "Kind: Name" but the record's */
  orgsTruncated?: boolean;
  /** which of them is the meeting's own matched record (#109): the only organisation a source may name */
  records?: string[];
};

/** what the host's UI sees of the live call companion (never a key) */
export type OleLiveState = {
  meetingId: string | null
  preparing: boolean
  /** the briefing, text included so it can be read from the start of the call (#35) */
  prepared: { meetingTitle: string | null; focus: string | null; preparedAt: number; text: string } | null
  error: string | null
  bullets: OleBullet[]
  /** questions asked during this call, newest first (#53) */
  answers: OleAnswer[]
  /** questions raised on the call and still open, and who said they will do what (#82); [] until the summary has them */
  openQuestions: string[]
  commitments: OleCommitment[]
  /** why Prepare and live context are off (Assistant on Local, or no OpenAI key); null when they can run */
  blocked: string | null
  /** enabled MCP servers Ole couldn't use for this briefing or call, and why (#33) */
  unavailable: Array<{ name: string; reason: string }>
}

/** how an Export for replay went; turns: the recorded bullets turns in the file (0 for a call from before they were kept) */
export type OleExportResult = { status: 'saved' | 'cancelled'; turns: number } | { status: 'failed'; error: string }
