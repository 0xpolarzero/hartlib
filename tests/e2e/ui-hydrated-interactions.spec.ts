import { build } from "esbuild";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

let bundle = "";

test.beforeAll(async () => {
  const result = await build({
    bundle: true,
    format: "iife",
    jsx: "automatic",
    loader: { ".tsx": "tsx" },
    platform: "browser",
    write: false,
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { useCallback, useState } from "react";
        import {
          AnnounceProvider,
          AssistantMessage,
          Combobox,
          Command,
          CommandEmpty,
          CommandInput,
          CommandItem,
          CommandList,
          DataTable,
          DatePicker,
          FileUpload,
          InlineEditableField,
          Dialog,
          DialogContent,
          DialogDescription,
          DialogFooter,
          DialogHeader,
          DialogTitle,
          DialogTrigger,
          DropdownMenu,
          DropdownMenuCheckboxItem,
          DropdownMenuContent,
          DropdownMenuItem,
          DropdownMenuTrigger,
          HoverCard,
          HoverCardContent,
          HoverCardTrigger,
          Popover,
          PopoverContent,
          PopoverTriggerButton,
          Select,
          SelectContent,
          SelectItem,
          SelectTrigger,
          SelectValue,
          Sheet,
          SheetContent,
          SheetTitle,
          SheetTrigger,
          ToastProvider,
          Tooltip,
          Transcript,
          useAnnounce,
          useToast,
          Tabs,
          TabsContent,
          TabsList,
          TabsTrigger,
        } from "./packages/ui/src/index.ts";

        const rows = Array.from({ length: 12 }, (_, index) => ({
          id: \`row-\${index + 1}\`,
          name: \`Row \${String(index + 1).padStart(2, "0")}\`,
          category: index % 2 === 0 ? "A" : "B",
        }));

        function TableHarness() {
          const [state, setState] = useState("data");
          const columns = [
            { accessorKey: "name", header: "Name" },
            { accessorKey: "category", header: "Category" },
          ];
          return (
            <section data-testid="table-harness">
              <div>
                <button type="button" data-testid="table-data" onClick={() => setState("data")}>Data</button>
                <button type="button" data-testid="table-loading" onClick={() => setState("loading")}>Loading</button>
                <button type="button" data-testid="table-empty" onClick={() => setState("empty")}>Empty</button>
                <button type="button" data-testid="table-error" onClick={() => setState("error")}>Error</button>
              </div>
              <DataTable
                ariaLabel="Rows"
                locale="en-US"
                columns={columns}
                data={rows}
                demoState={state}
                onRetry={() => setState("data")}
                facets={["category"]}
                enableSelection
                bulkActions={(selected, clear) => (
                  <button type="button" data-testid="bulk-delete" onClick={clear}>
                    Delete {selected.length}
                  </button>
                )}
                pageSize={2}
                emptyTitle="No rows"
                emptyDescription="There are no rows."
              />
            </section>
          );
        }

        const transcriptMessages = Array.from({ length: 80 }, (_, index) => ({
          id: \`message-\${index + 1}\`,
          author: index % 2 === 0 ? "user" : "assistant",
          content: index % 7 === 0
            ? \`Long answer \${index + 1}. This paragraph has enough text to force a measured row height.\`
            : \`Message \${index + 1}\`,
        }));

        function TranscriptHarness() {
          const [messages, setMessages] = useState(transcriptMessages);
          const [focusMessageId, setFocusMessageId] = useState(null);
          const [run, setRun] = useState(null);
          return (
            <section data-testid="transcript-harness">
              <button type="button" data-testid="transcript-add" onClick={() => setMessages((current) => [
                ...current,
                { id: \`message-\${current.length + 1}\`, author: "assistant", content: "A new answer" },
              ])}>Add answer</button>
              <button type="button" data-testid="transcript-stream" onClick={() => setRun({ id: "run-1", status: "running", streamedText: "A streamed answer" })}>Stream answer</button>
              <button type="button" data-testid="transcript-focus" onClick={() => setFocusMessageId("message-70")}>Focus message 70</button>
              <div style={{ height: "360px", display: "flex", flexDirection: "column" }}>
                <style>{
                  '[data-testid="chat-transcript-shell"]{height:100%;display:flex;flex:1;min-height:0}' +
                  '[data-testid="chat-transcript"]{height:100%;overflow-y:auto;overflow-x:hidden}'
                }</style>
                <Transcript messages={messages} run={run} focusMessageId={focusMessageId} />
              </div>
            </section>
          );
        }

        function MessageHarness() {
          const [selectedMessageId, setSelectedMessageId] = useState("");
          return (
            <section data-testid="message-harness">
              <AssistantMessage
                message={{
                  id: "assistant-viz-message",
                  author: "assistant",
                  content: "A cited answer with a visualization.",
                  referencesVisualization: true,
                }}
                onShowVisualization={(message) => setSelectedMessageId(message.id)}
              />
              <output data-testid="visualization-association">{selectedMessageId}</output>
            </section>
          );
        }

        function PrimitiveHarness() {
          const [comboValue, setComboValue] = useState(null);
          const [commandValue, setCommandValue] = useState("");
          const [dateValue, setDateValue] = useState(null);
          const [frenchDateValue, setFrenchDateValue] = useState(null);
          const [editableValue, setEditableValue] = useState("Editable source");
          const [uploadedFiles, setUploadedFiles] = useState([]);
          const [uploadError, setUploadError] = useState("");
          const loader = useCallback(async (query) => {
            await Promise.resolve();
            const options = [
              { value: "alpha", label: "Alpha" },
              { value: "beta", label: "Beta" },
              { value: "gamma", label: "Gamma" },
            ];
            return options.filter((option) => option.label.toLowerCase().includes(query.toLowerCase()));
          }, []);
          return (
            <section data-testid="primitive-harness">
              <div data-testid="combobox-harness">
                <Combobox
                  value={comboValue}
                  onChange={(option) => setComboValue(option?.value ?? null)}
                  loader={loader}
                  ariaLabel="Source"
                  placeholder="Choose source"
                />
                <span data-testid="combo-value">{comboValue ?? "none"}</span>
              </div>
              <div data-testid="command-harness">
                <Command onSelect={setCommandValue}>
                  <CommandInput aria-label="Commands" placeholder="Search commands" />
                  <CommandList aria-label="Commands">
                    <CommandEmpty>No commands</CommandEmpty>
                    <CommandItem value="first">First command</CommandItem>
                    <CommandItem value="disabled" disabled>Disabled command</CommandItem>
                    <CommandItem value="third">Third command</CommandItem>
                  </CommandList>
                </Command>
                <span data-testid="command-value">{commandValue || "none"}</span>
              </div>
              <Tabs defaultValue="one">
                <TabsList aria-label="Sections">
                  <TabsTrigger value="one">One</TabsTrigger>
                  <TabsTrigger value="two">Two</TabsTrigger>
                  <TabsTrigger value="three">Three</TabsTrigger>
                </TabsList>
                <TabsContent value="one">Panel one</TabsContent>
                <TabsContent value="two">Panel two</TabsContent>
                <TabsContent value="three">Panel three</TabsContent>
              </Tabs>
              <div data-testid="date-harness">
                <DatePicker ariaLabel="Date" value={dateValue} onChange={setDateValue} />
                <span data-testid="date-value">{dateValue ?? "none"}</span>
              </div>
              <div data-testid="french-date-harness">
                <DatePicker
                  ariaLabel="French date"
                  locale="fr-FR"
                  value={frenchDateValue}
                  onChange={setFrenchDateValue}
                />
              </div>
              <div data-testid="inline-harness">
                <InlineEditableField
                  value={editableValue}
                  ariaLabel="Source name"
                  locale="en-US"
                  onSave={setEditableValue}
                />
                <InlineEditableField
                  value="Long field"
                  ariaLabel="Long field"
                  locale="en-US"
                  multiline
                  onSave={() => undefined}
                />
              </div>
              <div data-testid="upload-harness">
                <FileUpload
                  files={uploadedFiles}
                  locale="en-US"
                  onUploaded={(file) => setUploadedFiles((current) => [...current, file])}
                  onValidationError={setUploadError}
                />
                <span data-testid="upload-error-value">{uploadError}</span>
              </div>
              <div data-testid="disabled-upload-harness">
                <FileUpload locale="en-US" />
              </div>
            </section>
          );
        }

        function Announcements() {
          const announce = useAnnounce();
          return (
            <div>
              <button type="button" data-testid="announce-status" onClick={() => announce.status("Ready")}>Announce status</button>
              <button type="button" data-testid="announce-alert" onClick={() => announce.alert("Something failed")}>Announce alert</button>
            </div>
          );
        }

        function ToastActions() {
          const { toast } = useToast();
          const [undoCount, setUndoCount] = useState(0);
          return (
            <div>
              <button type="button" data-testid="toast-show" onClick={() => toast({
                title: "Saved",
                description: "The change was saved.",
                tone: "success",
                durationMs: 30_000,
                undo: { label: "Undo", onUndo: () => setUndoCount((count) => count + 1) },
              })}>Show toast</button>
              <span data-testid="toast-undo-count">{undoCount}</span>
            </div>
          );
        }

        function OverlayHarness() {
          const [checked, setChecked] = useState(false);
          const [selected, setSelected] = useState("one");
          return (
            <section data-testid="overlay-harness">
              <div data-testid="outside" style={{ position: "fixed", top: "500px", left: "500px", width: "20px", height: "20px" }} />
              <Dialog>
                <DialogTrigger asChild><button data-testid="dialog-trigger" type="button">Open dialog</button></DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Modal title</DialogTitle></DialogHeader>
                  <DialogDescription>Modal description</DialogDescription>
                  <button type="button" data-testid="dialog-first">First action</button>
                  <button type="button" data-testid="dialog-second">Second action</button>
                  <DialogFooter><button type="button">Footer action</button></DialogFooter>
                </DialogContent>
              </Dialog>
              <Sheet>
                <SheetTrigger asChild><button data-testid="sheet-trigger" type="button">Open sheet</button></SheetTrigger>
                <SheetContent side="left"><SheetTitle>Sheet title</SheetTitle><button type="button">Sheet action</button></SheetContent>
              </Sheet>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><button data-testid="menu-trigger" type="button">Open menu</button></DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem>First menu item</DropdownMenuItem>
                  <DropdownMenuCheckboxItem checked={checked} onCheckedChange={setChecked}>Toggle menu item</DropdownMenuCheckboxItem>
                  <DropdownMenuItem>Last menu item</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Popover>
                <PopoverTriggerButton asChild><button data-testid="popover-trigger" type="button">Open popover</button></PopoverTriggerButton>
                <PopoverContent><button type="button">Popover action</button></PopoverContent>
              </Popover>
              <Tooltip content="Helpful tooltip"><button data-testid="tooltip-trigger" type="button">Tooltip trigger</button></Tooltip>
              <HoverCard><HoverCardTrigger asChild><button data-testid="hover-trigger" type="button">Hover trigger</button></HoverCardTrigger><HoverCardContent>Hover details</HoverCardContent></HoverCard>
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger aria-label="Choice"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="one">One</SelectItem><SelectItem value="two">Two</SelectItem><SelectItem value="three">Three</SelectItem></SelectContent>
              </Select>
              <Dialog>
                <DialogTrigger asChild><button data-testid="nested-dialog-trigger" type="button">Open nested dialog</button></DialogTrigger>
                <DialogContent>
                  <DialogTitle>Nested dialog</DialogTitle>
                  <Select defaultValue="one">
                    <SelectTrigger aria-label="Nested choice"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="one">One</SelectItem><SelectItem value="two">Two</SelectItem></SelectContent>
                  </Select>
                  <Tooltip content="Nested help"><button data-testid="nested-tooltip" type="button">Nested tooltip</button></Tooltip>
                </DialogContent>
              </Dialog>
            </section>
          );
        }

        function App() {
          return (
            <AnnounceProvider>
              <ToastProvider><Announcements /><ToastActions /><OverlayHarness /></ToastProvider>
            </AnnounceProvider>
          );
        }
        window.__mountUiHarness = (mode) => {
          const root = document.getElementById("root");
          if (!root) throw new Error("missing root");
          root.replaceChildren();
          const app = mode === "table" ? <TableHarness /> : mode === "transcript" ? <TranscriptHarness /> : mode === "message" ? <MessageHarness /> : mode === "overlay" ? <App /> : mode === "primitives" ? <AnnounceProvider><PrimitiveHarness /></AnnounceProvider> : <OverlayHarness />;
          createRoot(root).render(app);
        };
      `,
      loader: "tsx",
      resolveDir: process.cwd(),
      sourcefile: "ui-hydrated-interactions-harness.tsx",
    },
  });
  bundle = result.outputFiles[0]?.text ?? "";
  expect(bundle.length).toBeGreaterThan(0);
});

declare global {
  interface Window {
    __mountUiHarness?: (mode: string) => void;
  }
}

const mount = async (page: Page, mode: string): Promise<void> => {
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate((selectedMode) => window.__mountUiHarness?.(selectedMode), mode);
};

test("hydrated data tables cover filtering, sorting, facets, columns, selection, paging, and states", async ({
  page,
}) => {
  await mount(page, "table");
  const table = page.getByRole("table", { name: "Rows" });
  await expect(table).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search Rows" });
  await search.fill("Row 12");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("Row 12");
  await search.fill("");

  const nameSort = page.getByRole("button", { name: "Sort by Name" });
  await nameSort.click();
  await expect(table.locator("tbody tr").first()).toContainText("Row 01");
  await nameSort.click();
  await expect(table.locator("tbody tr").first()).toContainText("Row 12");

  const categoryFacet = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Category" }) });
  await categoryFacet.locator("summary").click();
  await page.getByRole("checkbox", { name: "B" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table).toContainText("Row 12");

  await page.getByRole("button", { name: "Columns" }).click();
  const nameColumn = page
    .locator("label")
    .filter({ hasText: /^Name$/u })
    .getByRole("checkbox");
  await nameColumn.click();
  await expect(table.locator("thead")).not.toContainText("Name");
  await nameColumn.click();

  await page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Category" }) })
    .locator("summary")
    .click();
  await page.getByRole("checkbox", { name: "Select all rows" }).click();
  await expect(page.getByRole("toolbar")).toContainText("2 selected");
  await page.getByTestId("bulk-delete").click();
  await expect(page.getByRole("toolbar")).toHaveCount(0);

  await page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Category" }) })
    .locator("summary")
    .click();
  await page.getByRole("checkbox", { name: "B" }).click();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("3–4 / 12")).toBeVisible();

  await page.getByTestId("table-loading").click();
  await expect(table).toBeVisible();
  await page.getByTestId("table-empty").click();
  await expect(page.getByText("No rows", { exact: true })).toBeVisible();
  await page.getByTestId("table-error").click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("table", { name: "Rows" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search Rows" }).fill("not found");
  await expect(page.getByText("No matching rows")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("table", { name: "Rows" })).toBeVisible();
});

test("hydrated primitives cover command, combobox, tabs, and localized calendar behavior", async ({
  page,
}) => {
  await mount(page, "primitives");

  const combobox = page.getByRole("combobox", { name: "Source" });
  await combobox.focus();
  await expect(page.getByRole("listbox", { name: "Source" })).toBeVisible();
  const sourceList = page.getByRole("listbox", { name: "Source" });
  await expect(sourceList.getByRole("option")).toHaveCount(3);
  await combobox.press("End");
  await combobox.press("Enter");
  await expect(combobox).toHaveValue("Gamma");
  await expect(page.getByTestId("combo-value")).toHaveText("gamma");
  await combobox.click();
  await expect(page.getByRole("listbox", { name: "Source" })).toBeVisible();
  await combobox.press("Escape");
  await expect(page.getByRole("listbox", { name: "Source" })).toHaveCount(0);
  await combobox.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("listbox", { name: "Source" })).toHaveCount(0);

  const commandInput = page.getByRole("combobox", { name: "Commands" });
  await commandInput.fill("third");
  await expect(page.getByRole("option", { name: "Third command" })).toBeVisible();
  await commandInput.press("Enter");
  await expect(page.getByTestId("command-value")).toHaveText("third");
  await commandInput.fill("disabled");
  await expect(page.getByRole("option", { name: "Disabled command" })).toBeDisabled();
  await commandInput.press("Enter");
  await expect(page.getByTestId("command-value")).toHaveText("third");
  await commandInput.fill("first");
  await commandInput.press("ArrowDown");
  await commandInput.press("Enter");
  await expect(page.getByTestId("command-value")).toHaveText("first");

  const tabs = page.getByRole("tab");
  await tabs.filter({ hasText: "Two" }).click();
  await expect(tabs.filter({ hasText: "Two" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveText("Panel two");
  await tabs.filter({ hasText: "Two" }).press("ArrowRight");
  await expect(tabs.filter({ hasText: "Three" })).toHaveAttribute("aria-selected", "true");
  await tabs.filter({ hasText: "Three" }).press("Home");
  await expect(tabs.filter({ hasText: "One" })).toHaveAttribute("aria-selected", "true");
  await tabs.filter({ hasText: "One" }).press("End");
  await expect(tabs.filter({ hasText: "Three" })).toHaveAttribute("aria-selected", "true");

  const date = page.getByTestId("date-harness");
  const dateTrigger = date.getByRole("button", { name: /^Date(?:,|$)/u });
  await dateTrigger.click();
  const calendar = date.getByRole("dialog");
  await expect(calendar.getByRole("gridcell")).toHaveCount(42);
  const calendarAxe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(calendarAxe.violations).toEqual([]);
  const month = calendar.locator("[aria-live='polite']");
  const beforeMonth = await month.textContent();
  await calendar.getByRole("button", { name: "Next month" }).click();
  await expect(month).not.toHaveText(beforeMonth ?? "");
  await expect(calendar.locator("[role='gridcell'][tabindex='0']")).toHaveCount(1);
  await calendar.locator("[role='gridcell'][tabindex='0']").press("ArrowRight");
  await calendar.locator("[role='gridcell'][tabindex='0']").press("Home");
  await calendar.locator("[role='gridcell'][tabindex='0']").press("End");
  await calendar.locator("[role='gridcell'][tabindex='0']").press("PageUp");
  await calendar.locator("[role='gridcell'][tabindex='0']").press("PageDown");
  await calendar.getByRole("gridcell").nth(15).click();
  await expect(page.getByTestId("date-value")).not.toHaveText("none");
  await dateTrigger.click();
  await calendar.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByTestId("date-value")).toHaveText("none");
  await dateTrigger.click();
  await calendar.locator("[role='gridcell'][tabindex='0']").press("Escape");
  await expect(dateTrigger).toBeFocused();

  const french = page.getByTestId("french-date-harness");
  const frenchTrigger = french.getByRole("button", { name: "French date", exact: true });
  await frenchTrigger.click();
  const frenchGrid = french.getByRole("grid");
  await expect(frenchGrid.getByRole("columnheader").first()).toContainText("lun");
  await expect(frenchGrid.locator("[role='gridcell']").first()).toHaveAttribute(
    "aria-label",
    /lundi/u,
  );
});

test("hydrated inline editing and uploads expose activation, cancellation, announcements, and validation", async ({
  page,
}) => {
  await mount(page, "primitives");

  const inline = page.getByTestId("inline-harness");
  const editButton = inline.getByRole("button", { name: /Edit — Source name/u });
  await editButton.click();
  const editor = inline.getByRole("textbox", { name: "Source name" });
  await editor.fill("Cancelled source");
  await editor.press("Escape");
  await expect(inline.getByRole("button", { name: /Edit — Source name/u })).toContainText(
    "Editable source",
  );
  await inline.getByRole("button", { name: /Edit — Source name/u }).click();
  await inline.getByRole("textbox", { name: "Source name" }).fill("Saved source");
  await inline.getByRole("textbox", { name: "Source name" }).press("Enter");
  await expect(inline.getByRole("button", { name: /Edit — Source name/u })).toContainText(
    "Saved source",
  );
  await expect(page.getByTestId("ui-announcer-status")).toHaveText("Change saved");

  const multiline = inline.getByRole("button", { name: /Edit — Long field/u });
  await multiline.click();
  const multilineEditor = inline.getByRole("textbox", { name: "Long field" });
  await multilineEditor.press("End");
  await multilineEditor.press("Shift+Enter");
  await expect(multilineEditor).toHaveValue(/Long field\n/u);
  await multilineEditor.press("Escape");

  const upload = page.getByTestId("upload-harness");
  const fileInput = upload.getByLabel("Drop PDF files here or choose files");
  await fileInput.setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a PDF"),
  });
  await expect(upload.getByRole("alert")).toContainText("notes.txt was rejected");
  await expect(page.getByTestId("upload-error-value")).toContainText("notes.txt");
  await upload.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(upload.getByRole("alert")).toHaveCount(0);

  const chooser = page.waitForEvent("filechooser");
  await upload.locator('div[role="button"]').press("Enter");
  await (
    await chooser
  ).setFiles({
    name: "evidence.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7"),
  });
  await expect(upload.getByText("evidence.pdf", { exact: true })).toBeVisible();

  const disabledUpload = page.getByTestId("disabled-upload-harness");
  const disabledDropZone = disabledUpload.locator('div[role="button"]');
  await expect(disabledDropZone).toHaveAttribute("aria-disabled", "true");
  await disabledDropZone.dispatchEvent("drop");
  await expect(disabledUpload.getByRole("list")).toHaveCount(0);
});

test("hydrated transcript virtualizes variable rows, fences near-bottom scroll, announces unread, and focuses offscreen rows", async ({
  page,
}) => {
  await mount(page, "transcript");
  const viewport = page.getByTestId("chat-transcript");
  await expect(viewport).toBeVisible();
  await expect.poll(() => viewport.locator("[data-message-id]").count()).toBeLessThan(80);
  const dimensions = await viewport.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.getByTestId("transcript-add").click();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await viewport.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await page.getByTestId("transcript-stream").click();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toContainText("1");
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);

  await page.getByTestId("transcript-focus").click();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-message-id")))
    .toBe("message-70");
  await expect(page.locator('[data-message-id="message-70"]')).toHaveAttribute("tabindex", "-1");
});

test("hydrated assistant message Show action selects its visualization association", async ({
  page,
}) => {
  await mount(page, "message");
  await expect(page.getByTestId("visualization-association")).toHaveText("");
  await page.getByRole("button", { name: "Show visualization" }).click();
  await expect(page.getByTestId("visualization-association")).toHaveText("assistant-viz-message");
});

test("hydrated overlays prove focus, keyboard loops, outside dismissal, select activation, toasts, and live announcements", async ({
  page,
}) => {
  await mount(page, "overlay");

  const dialogTrigger = page.getByTestId("dialog-trigger");
  await dialogTrigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid")))
    .toBe("dialog-first");
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await page.getByTestId("dialog-first").press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Close" }).last()).toBeFocused();
  await page.getByRole("button", { name: "Close" }).last().press("Tab");
  await expect(page.getByTestId("dialog-first")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(dialogTrigger).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");

  const sheetTrigger = page.getByTestId("sheet-trigger");
  await sheetTrigger.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveClass(/left-0/u);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(sheetTrigger).toBeFocused();

  const menuTrigger = page.getByTestId("menu-trigger");
  await expect(menuTrigger).toHaveAttribute("aria-haspopup", "menu");
  await menuTrigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemcheckbox")).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.getByTestId("outside").click();
  await expect(menu).toHaveCount(0);
  await expect(menuTrigger).toBeFocused();

  const popoverTrigger = page.getByTestId("popover-trigger");
  await expect(popoverTrigger).toHaveAttribute("aria-haspopup", "true");
  await popoverTrigger.click();
  await expect(page.getByText("Popover action")).toBeVisible();
  await popoverTrigger.press("Escape");
  await expect(page.getByText("Popover action")).toHaveCount(0);
  await expect(popoverTrigger).toBeFocused();
  await popoverTrigger.click();
  await expect(page.getByText("Popover action")).toBeVisible();
  await page.getByTestId("outside").click();
  await expect(page.getByText("Popover action")).toHaveCount(0);
  await expect(popoverTrigger).toBeFocused();

  const tooltipTrigger = page.getByTestId("tooltip-trigger");
  await tooltipTrigger.focus();
  await expect(page.getByRole("tooltip")).toContainText("Helpful tooltip");
  await tooltipTrigger.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await tooltipTrigger.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  const hoverTrigger = page.getByTestId("hover-trigger");
  await hoverTrigger.hover();
  await expect(page.getByText("Hover details", { exact: true })).toBeVisible();
  const hoverAxe = await new AxeBuilder({ page }).include("#root").analyze();
  expect(hoverAxe.violations).toEqual([]);

  const selectTrigger = page.getByRole("button", { name: "Choice" });
  await selectTrigger.press("Enter");
  const selectAxe = await new AxeBuilder({ page }).include('[role="listbox"]').analyze();
  expect(selectAxe.violations).toEqual([]);
  const options = page.getByRole("option");
  await expect(options.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toBeFocused();
  await page.keyboard.press(" ");
  await expect(selectTrigger).toContainText("Two");
  await selectTrigger.press("Enter");
  await page.keyboard.press("Escape");
  await expect(selectTrigger).toBeFocused();

  await page.getByTestId("announce-status").click();
  await expect(page.getByTestId("ui-announcer-status")).toHaveText("Ready");
  await page.getByTestId("announce-alert").click();
  await expect(page.getByTestId("ui-announcer-alert")).toHaveText("Something failed");

  await page.getByTestId("toast-show").click();
  const toast = page.getByRole("status").filter({ hasText: "Saved" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("toast-undo-count")).toHaveText("1");
  await page.getByTestId("toast-show").click();
  await page
    .getByRole("status")
    .filter({ hasText: "Saved" })
    .getByRole("button", { name: "Close" })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toHaveCount(0);

  const nestedTrigger = page.getByTestId("nested-dialog-trigger");
  await nestedTrigger.click();
  const nestedDialog = page.getByRole("dialog");
  await expect(nestedDialog).toBeVisible();
  const nestedSelect = nestedDialog.getByRole("button", { name: "Nested choice" });
  await nestedSelect.press("Enter");
  await expect(nestedDialog.getByRole("option").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(nestedDialog).toBeVisible();
  await page.getByTestId("nested-tooltip").focus();
  await page.keyboard.press("Escape");
  await expect(nestedDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(nestedDialog).toHaveCount(0);
});
