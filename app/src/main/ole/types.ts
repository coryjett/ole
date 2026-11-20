// Ole: shared types for the Ole additions to Yogurt.

export type SecretName = 'openai' | 'siesta';

export type ProviderChoice = 'local' | 'openai';

export type OleProviders = {
  transcription: ProviderChoice;
  assistant: ProviderChoice;
  openaiTranscribeModel: string;
  openaiChatModel: string;
  /** the Siesta MCP endpoint (https); '' until the person sets it */
  siestaUrl: string;
};

export type OleBullet = { id: string; text: string; source: string; at: number };

export type PreparedContext = {
  meetingTitle: string | null;
  accountId: string | null;
  accountName: string | null;
  text: string;
  preparedAt: number;
};
