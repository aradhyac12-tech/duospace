import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import MessageStatus from "@/components/chat/MessageStatus";

describe("MessageStatus ticks", () => {
  it("renders nothing for messages that are not mine", () => {
    const { container } = render(<MessageStatus isRead={false} isMine={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("sent = single tick", () => {
    const { container } = render(<MessageStatus isRead={false} isDelivered={false} isMine />);
    expect(container.querySelector("svg.lucide-check")).not.toBeNull();
    expect(container.querySelector("svg.lucide-check-check")).toBeNull();
  });

  it("delivered = double tick, not blue", () => {
    const { container } = render(<MessageStatus isRead={false} isDelivered isMine />);
    const svg = container.querySelector("svg.lucide-check-check");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("class")).not.toContain("text-info");
  });

  it("read = double blue tick, even if delivered_at is missing", () => {
    const { container } = render(<MessageStatus isRead isDelivered={false} isMine />);
    const svg = container.querySelector("svg.lucide-check-check");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("class")).toContain("text-info");
  });
});
