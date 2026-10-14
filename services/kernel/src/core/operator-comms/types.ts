export interface OperatorButton { text: string; data: string }
export interface OperatorMessage { text: string; buttons?: OperatorButton[][]; silent?: boolean }
export interface SentRef { target: string; messageId: string }
export interface OperatorChannelAdapter {
  readonly id: string;                         // provider id: "telegram", "whatsapp", …
  readonly buttons: boolean;                   // can show buttons and send their callbacks back
  readonly receive: boolean;                   // inbound text reaches tryCodeReply
  isReady(): boolean;
  send(msg: OperatorMessage): Promise<SentRef | null>;
  edit?(ref: SentRef, text: string): Promise<void>;
}
export type AnswerPort = (questionId: string, choice: import("../../modules/agents/question-delivery.js").HumanChoice)
  => import("../../modules/agents/question-delivery.js").ChoiceResult;
