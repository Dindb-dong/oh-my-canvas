import type { Data } from "../contracts";
import { createIcon } from "./icons";
const inputSynchronizers = new WeakMap<HTMLInputElement, {sync: (value: unknown) => void; dirty: () => boolean}>();
/** Update a retained control without treating the new displayed value as user input. */
export function syncInputValue(control: HTMLInputElement, value: unknown, preserveDraft = false): void {
    const state = inputSynchronizers.get(control);
    if (preserveDraft && state?.dirty())
        return;
    if (state)
        state.sync(value);
    else
        control.value = value == null ? "" : String(value);
}
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
    const n = document.createElement(tag);
    n.className = cls;
    if (text !== undefined)
        n.textContent = text;
    return n;
}
export function button(label: string, run: () => unknown, cls = "", title = label) {
    const n = el("button", cls, label);
    n.type = "button";
    n.title = title;
    n.setAttribute("aria-label", title);
    n.addEventListener("click", () => {
        try {
            const r = run();
            if (r instanceof Promise)
                r.catch(error => toast(String(error), "error"));
        }
        catch (error) {
            toast(String(error), "error");
        }
    });
    return n;
}
export function iconButton(name: string, run: () => unknown, cls = "", title: string) {
    const control = button("", run, `icon-button ${cls}`.trim(), title);
    control.append(createIcon(name));
    return control;
}
export function labeledIconButton(name: string, label: string, run: () => unknown, cls = "", title = label) {
    const control = button("", run, `has-icon ${cls}`.trim(), title);
    control.append(createIcon(name), document.createTextNode(label));
    return control;
}
export function toast(message: string, kind = "status") {
    document.querySelector(".omc-toast")?.remove();
    const n = el("div", "omc-toast", message);
    n.setAttribute("role", kind === "error" ? "alert" : "status");
    document.body.append(n);
    setTimeout(() => n.remove(), 5000);
}
export function input(label: string, value: any, change: (value: any) => any, type = "text") {
    const wrap = el("label", "field");
    wrap.append(el("span", "field-label", label));
    const n = el("input");
    n.type = type;
    n.setAttribute("aria-label", label);
    n.value = value == null ? "" : String(value);
    if (type === "number")
        n.step = "any";
    let committedValue = n.value;
    inputSynchronizers.set(n, {
        sync: value => {
            n.value = value == null ? "" : String(value);
            committedValue = n.value;
        },
        dirty: () => n.value !== committedValue
    });
    n.onchange = () => {
        committedValue = n.value;
        const v = type === "number" ? Number(n.value) : n.value;
        if (type === "number" && !Number.isFinite(v))
            return;
        try {
            const result = change(v);
            if (result instanceof Promise)
                result.catch(error => toast(String(error), "error"));
        }
        catch (e) {
            toast(String(e), "error");
        }
    };
    n.addEventListener("blur", () => {
        if (n.value !== committedValue)
            n.dispatchEvent(new Event("change", {
                bubbles: true
            }));
    });
    if (type === "number") {
        n.addEventListener("keydown", event => {
            if (!["ArrowUp", "ArrowDown"].includes(event.key))
                return;
            event.preventDefault();
            const step = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
            n.value = String((Number(n.value) || 0) + (event.key === "ArrowUp" ? step : -step));
            n.dispatchEvent(new Event("change", {
                bubbles: true
            }));
        });
        wrap.querySelector<HTMLElement>(".field-label")!.addEventListener("pointerdown", event => {
            if (event.button !== 0)
                return;
            event.preventDefault();
            const owner = wrap.closest("#right") ?? wrap;
            const start = new CustomEvent("numeric-start", {
                bubbles: true,
                cancelable: true
            });
            if (!owner.dispatchEvent(start))
                return;
            const origin = event.clientX, value = Number(n.value) || 0;
            let moved = false;
            const move = (event: PointerEvent) => {
                const dx = event.clientX - origin;
                if (Math.abs(dx) < 2 && !moved)
                    return;
                moved = true;
                const step = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
                n.value = String(Math.round((value + dx * step) * 1000) / 1000);
                n.dispatchEvent(new Event("change", {
                    bubbles: true
                }));
            };
            const finish = (cancel = false) => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                window.removeEventListener("keydown", key);
                owner.removeEventListener("numeric-dispose", dispose);
                owner.dispatchEvent(new CustomEvent("numeric-end", {
                    bubbles: true,
                    detail: {
                        cancel
                    }
                }));
                if (!moved)
                    n.focus();
            };
            const dispose = () => finish(true);
            owner.addEventListener("numeric-dispose", dispose, {
                once: true
            });
            const up = () => finish(), key = (event: KeyboardEvent) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    finish(true);
                }
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up, {
                once: true
            });
            window.addEventListener("keydown", key);
        });
    }
    wrap.append(n);
    return wrap;
}
export function select(label: string, value: any, values: (string | {
    value: string;
    label: string;
})[], change: (value: string) => unknown) {
    const wrap = el("label", "field");
    wrap.append(el("span", "field-label", label));
    const n = el("select");
    n.setAttribute("aria-label", label);
    for (const item of values) {
        const o = el("option");
        o.value = typeof item === "string" ? item : item.value;
        o.textContent = typeof item === "string" ? item : item.label;
        n.append(o);
    }
    n.value = String(value ?? "");
    n.onchange = () => {
        try {
            const result = change(n.value);
            if (result instanceof Promise)
                result.catch(error => toast(String(error), "error"));
        }
        catch (e) {
            toast(String(e), "error");
        }
    };
    wrap.append(n);
    return wrap;
}
export function check(label: string, value: any, change: (value: boolean) => unknown) {
    const n = el("label", "check");
    const i = el("input");
    i.type = "checkbox";
    i.checked = !!value;
    i.onchange = () => {
        try {
            const result = change(i.checked);
            if (result instanceof Promise)
                result.catch(error => toast(String(error), "error"));
        }
        catch (error) {
            toast(String(error), "error");
        }
    };
    n.append(i, document.createTextNode(label));
    return n;
}
export function section(title: string) {
    const n = el("section");
    n.append(el("h3", "", title));
    return n;
}
export function row(...nodes: (Node | null | undefined)[]) {
    const n = el("div", "fields");
    for (const node of nodes)
        if (node)
            n.append(node);
    return n;
}
export function modal(title: string, build: (body: HTMLElement, close: () => void) => void) {
    const previous = document.activeElement as HTMLElement;
    const dialog = el("dialog", "omc-dialog");
    const head = el("header");
    head.append(el("h2", "", title), iconButton("x", () => dialog.close(), "close", "Close"));
    const body = el("div", "dialog-body");
    dialog.append(head, body);
    const close = () => dialog.close();
    build(body, close);
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
        dialog.remove();
        previous?.focus();
    }, {
        once: true
    });
    dialog.showModal();
    return dialog;
}
export function jsonEditor(title: string, value: Data | Data[], save: (v: any) => void) {
    modal(title, (body, close) => {
        const area = el("textarea", "json-editor");
        area.value = JSON.stringify(value, null, 2);
        area.setAttribute("aria-label", title);
        const error = el("p", "field-error");
        body.append(area, error, button("Apply", () => {
            try {
                save(JSON.parse(area.value));
                close();
            }
            catch (e) {
                error.textContent = String(e);
            }
        }, "primary"));
    });
}
export function askName(title: string, value: string, save: (v: string) => unknown) {
    modal(title, (body, close) => {
        const field = input("Name", value, () => {
        });
        body.append(field, button("Save", async () => {
            const name = field.querySelector("input")!.value.trim();
            if (name) {
                await save(name);
                close();
            }
        }, "primary"));
        field.querySelector("input")?.select();
    });
}
export function download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
}
export function clone<T>(value: T): T {
    return structuredClone(value);
}
export const textValue = (content: any): string => typeof content === "string" ? content : (content?.children ?? []).map((p: any) => (p.children ?? []).map((r: any) => r.text ?? "").join("")).join("\n");
