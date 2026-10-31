interface QuotedMessageProps {
  content: string;
  senderName: string;
  isMine: boolean;
}

const QuotedMessage = ({ content, senderName, isMine }: QuotedMessageProps) => (
  <div className={`mb-1.5 rounded-lg px-2.5 py-1.5 border-l-2 ${
    isMine
      ? "bg-primary-foreground/15 border-primary-foreground/40"
      : "bg-muted/50 border-muted-foreground/30"
  }`}>
    <p className={`text-[11px] font-medium truncate ${isMine ? "text-primary-foreground/80" : "text-primary"}`}>{senderName}</p>
    <p className={`text-xs truncate ${isMine ? "text-primary-foreground/60" : "text-muted-foreground"}`}>{content}</p>
  </div>
);

export default QuotedMessage;
