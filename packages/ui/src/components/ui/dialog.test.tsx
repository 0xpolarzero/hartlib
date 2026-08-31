import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  Dialog,
  DialogContent,
  DialogTitle,
} from "./dialog";

describe("dialog focus boundary", () => {
  it("renders a modal role and a labelled title", () => {
    const html = renderToStaticMarkup(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Confirm reset</DialogTitle>
          <button type="button">Reset</button>
        </DialogContent>
      </Dialog>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Confirm reset");
  });

  it("renders destructive confirmations with an alertdialog role", () => {
    const html = renderToStaticMarkup(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Delete message?</AlertDialogTitle>
          <button type="button">Delete</button>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).not.toContain('role="dialog"');
  });
});
