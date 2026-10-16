import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/haptics", () => ({ hapticHeavy: vi.fn() }));

import ConfirmActionDialog from "@/components/settings/ConfirmActionDialog";

const Harness = ({ onConfirm, approvalNote }: { onConfirm: () => void | boolean | Promise<void | boolean>; approvalNote?: string }) => {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={setOpen}
      title="Ask to unlink?"
      whatHappens="We'll send a request."
      dataAffected="Nothing is deleted."
      reversible
      authRequired={false}
      approvalNote={approvalNote}
      confirmLabel="Send request"
      onConfirm={onConfirm}
    />
  );
};

describe("ConfirmActionDialog", () => {
  it("closes itself after a successful confirm (the reported bug: it used to stay open)", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<Harness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("closes after a synchronous confirm handler too", async () => {
    render(<Harness onConfirm={() => { /* nothing */ }} />);
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("stays open when the handler resolves false, so the person can retry", async () => {
    const onConfirm = vi.fn().mockResolvedValue(false);
    render(<Harness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // and the button is usable again
    await waitFor(() => expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled());
  });

  it("shows the approval row only when an approval note is given", () => {
    const { rerender } = render(<Harness onConfirm={() => {}} />);
    expect(screen.queryByText("Approval")).not.toBeInTheDocument();
    rerender(<Harness onConfirm={() => {}} approvalNote="Your partner must allow it." />);
    expect(screen.getByText("Approval")).toBeInTheDocument();
    expect(screen.getByText("Your partner must allow it.")).toBeInTheDocument();
  });
});
