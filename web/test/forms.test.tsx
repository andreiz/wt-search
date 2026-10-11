// The report and feedback forms (spec §5.5, §4.4; plan 3 Task 13): opened from ⋯ under a hit and
// from the footer, with a fake Turnstile (no network) and a stubbed API.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { createRef } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { Footer } from "../src/components/Footer";
import { QUOTE_HINT } from "../src/components/ReportForm";
import { ResultList } from "../src/components/ResultList";
import { FormSiteContext, type FormSite } from "../src/use-forms";
import { ReportMaintenance } from "../src/use-transcript";
import { chunkOf, contextAnswer, HIT } from "./fixtures/context";
import { exactBody, infoBody, result, stubFetch, type Calls } from "./helpers";
import { fakeTurnstile } from "./turnstile-fake";

let fake: ReturnType<typeof fakeTurnstile>;
let calls: Calls;

beforeEach(() => {
  fake = fakeTurnstile();
  calls = stubFetch();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  fake.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const READY: FormSite = { status: "ready", siteKey: "SITE", ask: () => {} };
const NO_KEY: FormSite = { status: "unavailable", siteKey: null, ask: () => {} };

function renderList(site: FormSite = READY, onMaintenance = vi.fn(), results = [result(1), result(2)]) {
  const listRef = createRef<HTMLDivElement>();
  const view = render(
    <ReportMaintenance.Provider value={onMaintenance}>
      <FormSiteContext.Provider value={site}>
        <ResultList results={results} page={1} listRef={listRef} />
      </FormSiteContext.Provider>
    </ReportMaintenance.Provider>,
  );
  return { ...view, onMaintenance };
}

function menuReport(index = 0) {
  fireEvent.click(screen.getAllByRole("button", { name: "More actions" })[index]!);
  fireEvent.click(screen.getByRole("menuitem", { name: "Report transcript error" }));
}

/** Open the report form of the hit at `index` and let the (fake) script load and the widget render. */
async function openReport(index = 0) {
  menuReport(index);
  await fake.ready();
  await waitFor(() => expect(fake.widgets.length).toBeGreaterThan(0));
}

const reportForm = () => screen.getByRole("form", { name: "Report a transcript error" });
const field = (label: string) => within(reportForm()).getByLabelText(new RegExp(`^${label}`)) as HTMLTextAreaElement;
/** A field's counter: the first thing that describes it (a hint, if any, comes after). */
const counter = (label: string) => document.getElementById(field(label).getAttribute("aria-describedby")!.split(" ")[0]!)!;
const sendButton = (form: HTMLElement) => within(form).getByRole("button", { name: /^Send/ }) as HTMLButtonElement;
const typeInto = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } });

describe("opening the report form", () => {
  it("opens under its hit, inside the card, with the excerpt quoted and focus in the field", async () => {
    renderList();
    expect(fake.scripts).toHaveLength(0);
    await openReport();
    const form = reportForm();
    expect(form.closest("li")?.textContent).toContain("Show 1 title");
    expect(field("Quoted text").value).toBe("Text of passage 1");
    expect(document.activeElement).toBe(field("Quoted text"));
  });

  it("loads the Turnstile script only now, once, and renders the widget with the site key", async () => {
    renderList();
    expect(fake.scripts).toHaveLength(0);
    menuReport();
    expect(fake.scripts).toHaveLength(1);
    await fake.ready();
    await waitFor(() => expect(fake.widgets).toHaveLength(1));
    expect(fake.widgets[0]!.options.sitekey).toBe("SITE");
    expect(reportForm().contains(fake.widgets[0]!.el)).toBe(true);
    // Another form later does not load it again.
    fireEvent.click(within(reportForm()).getByRole("button", { name: "Cancel" }));
    menuReport(1);
    await waitFor(() => expect(fake.widgets).toHaveLength(2));
    expect(fake.scripts).toHaveLength(1);
  });

  it("asks the page for the site key when it opens", () => {
    const ask = vi.fn();
    renderList({ status: "loading", siteKey: null, ask });
    expect(ask).not.toHaveBeenCalled();
    menuReport();
    expect(ask).toHaveBeenCalledTimes(1);
    // While the key is on its way the fields are there and no widget is.
    expect(field("Quoted text")).toBeTruthy();
    expect(fake.scripts).toHaveLength(0);
  });

  it("only one report form is open on the page", async () => {
    renderList();
    await openReport(0);
    menuReport(1);
    expect(screen.getAllByRole("form", { name: "Report a transcript error" })).toHaveLength(1);
    expect(field("Quoted text").value).toBe("Text of passage 2");
    expect(reportForm().closest("li")?.textContent).toContain("Show 2 title");
  });

  it("says reporting is unavailable, with nothing to send, when there is no site key", () => {
    renderList(NO_KEY);
    menuReport();
    const form = reportForm();
    expect(within(form).getByText("Reporting is unavailable right now. Please try again later.")).toBeTruthy();
    expect(within(form).queryByRole("textbox")).toBeNull();
    expect(within(form).queryByRole("button", { name: /^Send/ })).toBeNull();
    expect(fake.scripts).toHaveLength(0);
    expect(document.activeElement).toBe(form);
    fireEvent.click(within(form).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("form")).toBeNull();
  });
});

describe("what is quoted", () => {
  function select(node: Node, text: string) {
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      toString: () => text,
    } as unknown as Selection);
  }
  const excerptOf = (n: number) => screen.getByText(`Text of passage ${n}`);

  it("is the selection when it lies inside this card's excerpt", () => {
    renderList();
    select(excerptOf(1).firstChild!, "  passage\n 1 ");
    menuReport();
    expect(field("Quoted text").value).toBe("passage 1");
  });

  it("is the excerpt when the selection is elsewhere, or in another card, or empty", () => {
    renderList();
    select(document.body, "something else");
    menuReport();
    expect(field("Quoted text").value).toBe("Text of passage 1");
    cleanup();

    renderList();
    select(excerptOf(2).firstChild!, "passage 2");
    menuReport();
    expect(field("Quoted text").value).toBe("Text of passage 1");
    cleanup();

    renderList();
    vi.spyOn(window, "getSelection").mockReturnValue({ rangeCount: 0, isCollapsed: true, toString: () => "" } as unknown as Selection);
    menuReport();
    expect(field("Quoted text").value).toBe("Text of passage 1");
  });

  it("is the selection when it lies inside the card's open transcript", async () => {
    renderList(READY, vi.fn(), [HIT]);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "More transcript" }));
    calls[0]!.respond(contextAnswer(3));
    await waitFor(() => expect(document.querySelectorAll(".passage__text").length).toBeGreaterThan(2));
    const other = [...document.querySelectorAll(".passage__text")].find((p) => p.textContent === chunkOf(2).text)!;
    select(other.firstChild!, "glue");
    menuReport();
    expect(field("Quoted text").value).toBe("glue");
  });

  it("keeps a long excerpt to 500 code points", () => {
    renderList(READY, vi.fn(), [result(1, { text: "ab ".repeat(400) })]);
    menuReport();
    expect(field("Quoted text").value.length).toBeLessThanOrEqual(500);
    expect(field("Quoted text").getAttribute("aria-invalid")).toBeNull();
  });

  it("says how to quote other words, in a hint tied to the field", () => {
    renderList();
    menuReport();
    const hint = within(reportForm()).getByText(QUOTE_HINT);
    expect(field("Quoted text").getAttribute("aria-describedby")?.split(" ")).toContain(hint.id);
  });
});

describe("counters and Send", () => {
  it("count code points, show each counter next to its field, and tie it to the field", async () => {
    renderList();
    await openReport();
    typeInto(field("Quoted text"), "😀😀😀");
    expect(counter("Quoted text").textContent).toBe("3 / 500");
    typeInto(field("Suggested correction"), "abc");
    expect(counter("Suggested correction").textContent).toBe("3 / 500");
    typeInto(field("Note"), "  hi  ");
    expect(counter("Note").textContent).toBe("2 / 1000");
  });

  it("agree with the Worker's limit: 500 emoji fit (1000 UTF-16 units), 501 do not", async () => {
    renderList();
    await openReport();
    fake.token("tok");
    typeInto(field("Quoted text"), "😀".repeat(500));
    expect(sendButton(reportForm()).disabled).toBe(false);
    typeInto(field("Quoted text"), "😀".repeat(501));
    expect(sendButton(reportForm()).disabled).toBe(true);
    expect(field("Quoted text").getAttribute("aria-invalid")).toBe("true");
    expect(counter("Quoted text").textContent).toContain("501 / 500");
    typeInto(field("Quoted text"), "ok");
    typeInto(field("Note"), "n".repeat(1001));
    expect(sendButton(reportForm()).disabled).toBe(true);
    typeInto(field("Note"), "n".repeat(1000));
    expect(sendButton(reportForm()).disabled).toBe(false);
  });

  it("Send waits for a token and for something quoted, and an expired token takes it away", async () => {
    renderList();
    await openReport();
    expect(sendButton(reportForm()).disabled).toBe(true);
    fake.token("tok");
    expect(sendButton(reportForm()).disabled).toBe(false);
    typeInto(field("Quoted text"), "   ");
    expect(sendButton(reportForm()).disabled).toBe(true);
    typeInto(field("Quoted text"), "word");
    expect(sendButton(reportForm()).disabled).toBe(false);
    fake.expire();
    expect(sendButton(reportForm()).disabled).toBe(true);
    fake.token("tok2");
    expect(sendButton(reportForm()).disabled).toBe(false);
  });

  it("submitting with Enter cannot get round the disabled button", async () => {
    renderList();
    await openReport();
    fireEvent.submit(reportForm());
    expect(calls).toHaveLength(0);
    fake.token("tok");
    typeInto(field("Quoted text"), "");
    fireEvent.submit(reportForm());
    expect(calls).toHaveLength(0);
  });
});

describe("sending a report", () => {
  async function ready() {
    renderList();
    await openReport();
    fake.token("tok");
  }

  it("posts the fields, trimmed, with the chunk and the token; optional ones empty are left out", async () => {
    await ready();
    typeInto(field("Quoted text"), "  the quoted bit ");
    fireEvent.click(sendButton(reportForm()));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/api/report");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ chunk_id: 1001, quoted_text: "the quoted bit", turnstile_token: "tok" });
  });

  it("posts the suggestion and the note when given", async () => {
    await ready();
    typeInto(field("Suggested correction"), " fixed ");
    typeInto(field("Note"), " because ");
    fireEvent.click(sendButton(reportForm()));
    expect(calls[0]!.body).toEqual({
      chunk_id: 1001,
      quoted_text: "Text of passage 1",
      suggested_text: "fixed",
      note: "because",
      turnstile_token: "tok",
    });
  });

  it("while sending: 70% (a class), 'Sending…', disabled, no second request", async () => {
    await ready();
    const form = reportForm();
    fireEvent.click(sendButton(form));
    const button = sendButton(form);
    expect(button.textContent).toBe("Sending…");
    expect(button.disabled).toBe(true);
    expect(form.querySelector(".form__body--sending")).toBeTruthy();
    fireEvent.submit(form);
    expect(calls).toHaveLength(1);
  });

  it("sent: thanks in a status, the widget removed, the fields gone", async () => {
    await ready();
    fireEvent.click(sendButton(reportForm()));
    calls[0]!.respond({ ok: true });
    const thanks = await within(reportForm()).findByRole("status");
    expect(thanks.textContent).toContain("Thanks — we'll review it.");
    await waitFor(() => expect(fake.removed).toEqual(["widget-1"]));
    expect(within(reportForm()).queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(thanks);
  });

  it.each([
    [400, "Quote some of what the show said."],
    [403, "The check didn't pass. Please try again."],
    [429, "Too many reports from here. Try again in a minute."],
  ])("a %i shows the API's message, keeps what was typed, resets the widget", async (status, message) => {
    await ready();
    typeInto(field("Suggested correction"), "my fix");
    typeInto(field("Note"), "my note");
    fireEvent.click(sendButton(reportForm()));
    calls[0]!.respond({ error: "x", message }, status, status === 429 ? { "retry-after": "60" } : {});
    const alert = await within(reportForm()).findByRole("alert");
    expect(alert.textContent).toContain(message);
    expect(field("Quoted text").value).toBe("Text of passage 1");
    expect(field("Suggested correction").value).toBe("my fix");
    expect(field("Note").value).toBe("my note");
    expect(fake.resets).toEqual(["widget-1"]);
    // The token is spent: Send is off until the widget gives a new one.
    expect(sendButton(reportForm()).disabled).toBe(true);
    expect(sendButton(reportForm()).textContent).toBe("Send");
    fake.token("tok-2");
    expect(sendButton(reportForm()).disabled).toBe(false);
    fireEvent.click(sendButton(reportForm()));
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body as { turnstile_token: string }).turnstile_token).toBe("tok-2");
  });

  it("a 429 without a message, and other 5xx, and a dropped connection each say something and reset", async () => {
    await ready();
    const tries: [() => void, RegExp][] = [
      [() => calls[0]!.respond({}, 429, { "retry-after": "30" }), /Too many reports/],
      [() => calls[1]!.respond("nope", 502), /Couldn't send that right now/],
      [() => calls[2]!.fail(), /Couldn't reach the server/],
    ];
    for (const [i, [answer, text]] of tries.entries()) {
      fireEvent.click(sendButton(reportForm()));
      answer();
      const alert = await within(reportForm()).findByRole("alert");
      expect(alert.textContent).toMatch(text);
      expect(fake.resets).toHaveLength(i + 1);
      fake.token(`again-${i}`);
    }
  });

  it("a maintenance answer raises the page's banner and is shown inline", async () => {
    const onMaintenance = vi.fn();
    renderList(READY, onMaintenance);
    await openReport();
    fake.token("tok");
    fireEvent.click(sendButton(reportForm()));
    calls[0]!.respond({ error: "maintenance", message: "Down for repairs." }, 503);
    const alert = await within(reportForm()).findByRole("alert");
    expect(alert.textContent).toContain("Down for repairs.");
    expect(onMaintenance).toHaveBeenCalledWith("Down for repairs.");
    expect(fake.resets).toHaveLength(1);
  });
});

describe("closing the report form", () => {
  it("Esc leaves it open with what was typed, so a stray press loses nothing", async () => {
    renderList();
    await openReport();
    typeInto(field("Note"), "typed");
    fireEvent.keyDown(field("Note"), { key: "Escape" });
    expect(field("Note").value).toBe("typed");
    expect(fake.removed).toEqual([]);
  });

  it("Esc closes it once it is sent and returns focus to that hit's ⋯", async () => {
    renderList();
    await openReport(1);
    const more = screen.getAllByRole("button", { name: "More actions" })[1]!;
    fake.token("tok");
    fireEvent.click(sendButton(reportForm()));
    calls[0]!.respond({ ok: true });
    const thanks = await within(reportForm()).findByRole("status");
    fireEvent.keyDown(thanks, { key: "Escape" });
    expect(screen.queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("Esc closes it when reporting is unavailable", () => {
    renderList(NO_KEY);
    menuReport();
    fireEvent.keyDown(reportForm(), { key: "Escape" });
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("Cancel and × close it, remove the widget and return focus to that hit's ⋯", async () => {
    renderList();
    await openReport();
    const more = screen.getAllByRole("button", { name: "More actions" })[0]!;
    fireEvent.click(within(reportForm()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(more);
    await openReport();
    fireEvent.click(within(reportForm()).getByRole("button", { name: "Close report form" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(fake.removed).toEqual(["widget-1", "widget-2"]);
  });

  it("a reopened form starts fresh", async () => {
    renderList();
    await openReport();
    typeInto(field("Note"), "typed");
    fireEvent.click(within(reportForm()).getByRole("button", { name: "Cancel" }));
    menuReport();
    expect(field("Note").value).toBe("");
  });
});

describe("when the script does not load", () => {
  it("says so and offers another try", async () => {
    renderList();
    menuReport();
    await fake.fail();
    const alert = await within(reportForm()).findByRole("alert");
    expect(alert.textContent).toContain("The security check couldn't load.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(fake.scripts).toHaveLength(2);
    await fake.ready();
    await waitFor(() => expect(fake.widgets).toHaveLength(1));
    expect(within(reportForm()).queryByRole("alert")).toBeNull();
  });
});

describe("markup", () => {
  it("has labels, a labelled form, 44 px buttons by class and no style attributes", async () => {
    const { container } = renderList();
    await openReport();
    const form = reportForm();
    expect(form.tagName).toBe("FORM");
    for (const label of ["Quoted text", "Suggested correction", "Note"]) expect(field(label)).toBeTruthy();
    expect(sendButton(form).classList.contains("form__send")).toBe(true);
    expect(within(form).getByRole("button", { name: "Cancel" }).classList.contains("form__cancel")).toBe(true);
    expect(container.querySelectorAll("[style]").length).toBe(0);
  });
});

describe("the feedback form", () => {
  function renderFooter(site: FormSite = READY, onMaintenance = vi.fn()) {
    return render(
      <ReportMaintenance.Provider value={onMaintenance}>
        <FormSiteContext.Provider value={site}>
          <Footer feedback />
        </FormSiteContext.Provider>
      </ReportMaintenance.Provider>,
    );
  }
  const opener = () => screen.getByRole("button", { name: "Send feedback" });
  const feedbackForm = () => screen.getByRole("form", { name: "Send feedback" });
  const message = () => within(feedbackForm()).getByLabelText(/^Message/) as HTMLTextAreaElement;

  async function open() {
    fireEvent.click(opener());
    await fake.ready();
    await waitFor(() => expect(fake.widgets).toHaveLength(1));
  }

  it("opens inline in the footer: helper, counter, the widget, focus in the message", async () => {
    renderFooter();
    expect(fake.scripts).toHaveLength(0);
    await open();
    expect(screen.getByRole("contentinfo").contains(feedbackForm())).toBe(true);
    expect(fake.widgets[0]!.options.sitekey).toBe("SITE");
    expect(document.activeElement).toBe(message());
    const described = message().getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent);
    expect(described).toEqual(["0 / 1000", "Search didn't find something? Have an idea? Tell us."]);
    typeInto(message(), "😀 hi");
    expect(document.getElementById("feedback-message-count")!.textContent).toBe("4 / 1000");
  });

  it("posts exactly {note, turnstile_token}: no chunk_id key at all", async () => {
    renderFooter();
    await open();
    expect(sendButton(feedbackForm()).disabled).toBe(true);
    typeInto(message(), "  Searched milk paint, found nothing. ");
    expect(sendButton(feedbackForm()).disabled).toBe(true);
    fake.token("tok");
    expect(sendButton(feedbackForm()).disabled).toBe(false);
    fireEvent.click(sendButton(feedbackForm()));
    expect(calls[0]!.url.pathname).toBe("/api/report");
    expect(calls[0]!.body).toEqual({ note: "Searched milk paint, found nothing.", turnstile_token: "tok" });
    expect("chunk_id" in (calls[0]!.body as object)).toBe(false);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("chunk_id");
    expect(sendButton(feedbackForm()).textContent).toBe("Sending…");
    calls[0]!.respond({ ok: true });
    const thanks = await within(feedbackForm()).findByRole("status");
    expect(thanks.textContent).toContain("Thanks — we read every message.");
    await waitFor(() => expect(fake.removed).toEqual(["widget-1"]));
  });

  it("limits the message to 1000 code points", async () => {
    renderFooter();
    await open();
    fake.token("tok");
    typeInto(message(), "😀".repeat(1000));
    expect(sendButton(feedbackForm()).disabled).toBe(false);
    typeInto(message(), "😀".repeat(1001));
    expect(sendButton(feedbackForm()).disabled).toBe(true);
  });

  it("a refusal shows the message, keeps the text, resets the widget and clears the token", async () => {
    renderFooter();
    await open();
    typeInto(message(), "an idea");
    fake.token("tok");
    fireEvent.click(sendButton(feedbackForm()));
    calls[0]!.respond({ error: "x", message: "That check didn't pass." }, 403);
    const alert = await within(feedbackForm()).findByRole("alert");
    expect(alert.textContent).toContain("That check didn't pass.");
    expect(message().value).toBe("an idea");
    expect(fake.resets).toEqual(["widget-1"]);
    expect(sendButton(feedbackForm()).disabled).toBe(true);
  });

  it("Esc leaves it open; Cancel closes it and returns focus to Send feedback", async () => {
    renderFooter();
    await open();
    typeInto(message(), "an idea");
    fireEvent.keyDown(message(), { key: "Escape" });
    expect(message().value).toBe("an idea");
    expect(opener().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(feedbackForm()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(opener());
    expect(opener().getAttribute("aria-expanded")).toBe("false");
    expect(fake.removed).toEqual(["widget-1"]);
  });

  it("says feedback is unavailable when there is no site key", () => {
    renderFooter(NO_KEY);
    fireEvent.click(opener());
    expect(within(feedbackForm()).getByText("Reporting is unavailable right now. Please try again later.")).toBeTruthy();
    expect(within(feedbackForm()).queryByRole("textbox")).toBeNull();
    expect(fake.scripts).toHaveLength(0);
  });
});

describe("in <App/>: the site key from /api/info", () => {
  async function searched() {
    window.history.replaceState(null, "", "/?q=glue&mode=exact");
    render(<App />);
    calls[0]!.respond(exactBody([result(1)]));
    await screen.findByText("Text of passage 1");
  }

  it("a page that opens on a search asks /api/info only when the first form opens, and only once", async () => {
    await searched();
    expect(calls.info).toHaveLength(0);
    menuReport();
    expect(calls.info).toHaveLength(1);
    // Nothing loads from Cloudflare until there is a key to render with.
    expect(fake.scripts).toHaveLength(0);
    calls.info[0]!.respond(infoBody({ turnstile_site_key: "KEY" }));
    await waitFor(() => expect(fake.scripts).toHaveLength(1));
    await fake.ready();
    await waitFor(() => expect(fake.widgets).toHaveLength(1));
    expect(fake.widgets[0]!.options.sitekey).toBe("KEY");
    // The feedback form uses the same answer.
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(fake.widgets).toHaveLength(2));
    expect(fake.widgets[1]!.options.sitekey).toBe("KEY");
    expect(calls.info).toHaveLength(1);
  });

  it("the empty state's request is the one the footer's form uses", async () => {
    render(<App />);
    expect(calls.info).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(calls.info).toHaveLength(1);
    calls.info[0]!.respond(infoBody({ turnstile_site_key: "KEY" }));
    await fake.ready();
    await waitFor(() => expect(fake.widgets).toHaveLength(1));
  });

  it("a null site key, or a failed /api/info, makes the form say reporting is unavailable", async () => {
    await searched();
    menuReport();
    calls.info[0]!.respond(infoBody({ turnstile_site_key: null }));
    expect(await screen.findByText("Reporting is unavailable right now. Please try again later.")).toBeTruthy();
    cleanup();

    calls = stubFetch();
    await searched();
    menuReport();
    calls.info[0]!.respond({}, 500);
    expect(await screen.findByText("Reporting is unavailable right now. Please try again later.")).toBeTruthy();
    expect(fake.scripts).toHaveLength(0);
  });

  it("a maintenance answer to the report raises the page's banner", async () => {
    await searched();
    menuReport();
    calls.info[0]!.respond(infoBody({ turnstile_site_key: "KEY" }));
    await fake.ready();
    await waitFor(() => expect(fake.widgets).toHaveLength(1));
    fake.token("tok");
    fireEvent.click(sendButton(reportForm()));
    calls[1]!.respond({ error: "maintenance", message: "Back soon." }, 503);
    await waitFor(() => expect(screen.getAllByText("Back soon.").length).toBeGreaterThan(0));
    expect(document.querySelector(".banner")?.textContent).toBe("Back soon.");
  });
});
