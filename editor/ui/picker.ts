import type { MountOptions } from "../contracts";
export type FilePickerRequest = { kind: "image" | "assets" | "library"; multiple?: boolean };
const accepts = {
    image: "image/*,.svg",
    assets: "image/*,.svg,.woff,.woff2,.ttf,.otf,.json,.fig,.sketch",
    library: ".json"
};
/** Desktop delegates to its host. Browser inputs remain attached until change/cancel. */
export function chooseFiles(options: Pick<MountOptions, "pickFiles">, request: FilePickerRequest, signal?: AbortSignal): Promise<File[]> {
    if (signal?.aborted)
        return Promise.resolve([]);
    return new Promise((resolve, reject) => {
        let input: HTMLInputElement | undefined, finished = false;
        const cleanup = () => {
            signal?.removeEventListener("abort", cancel);
            input?.remove();
            if (input)
                input.onchange = input.oncancel = null;
        };
        const finish = (files: File[]) => {
            if (finished)
                return;
            finished = true;
            cleanup();
            resolve(request.multiple ? files : files.slice(0, 1));
        };
        const fail = (error: unknown) => {
            if (finished)
                return;
            finished = true;
            cleanup();
            reject(error);
        };
        const cancel = () => finish([]);
        signal?.addEventListener("abort", cancel, { once: true });
        if (options.pickFiles) {
            Promise.resolve().then(() => finished ? [] : options.pickFiles!(request)).then(finish, fail);
            return;
        }
        input = document.createElement("input");
        input.type = "file";
        input.accept = accepts[request.kind];
        input.multiple = !!request.multiple;
        input.hidden = true;
        input.dataset.filePicker = request.kind;
        input.onchange = () => finish(Array.from(input!.files ?? []));
        input.oncancel = cancel;
        document.body.append(input);
        try {
            input.click();
        }
        catch (error) {
            fail(error);
        }
    });
}
export async function readImageFile(file: File) {
    const src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? Error("Could not read image"));
        reader.readAsDataURL(file);
    });
    const image = new Image();
    image.src = src;
    await image.decode();
    return { src, width: image.naturalWidth, height: image.naturalHeight, mimeType: file.type };
}
