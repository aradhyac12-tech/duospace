import { cn } from "@/lib/utils";

interface CodeSurpriseFrameProps {
  className?: string;
  documentHtml: string;
  title: string;
}

const CodeSurpriseFrame = ({ className, documentHtml, title }: CodeSurpriseFrameProps) => {
  return (
    <iframe
      title={title}
      sandbox="allow-scripts"
      srcDoc={documentHtml}
      className={cn("w-full h-full rounded-2xl border border-border/30 bg-background", className)}
    />
  );
};

export default CodeSurpriseFrame;