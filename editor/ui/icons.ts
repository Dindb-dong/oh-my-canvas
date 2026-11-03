import { svgIcon } from "./icons/tabler/runtime.js";
export function createIcon(name: string, size = 18): SVGSVGElement {
    const host = document.createElement("span");
    host.innerHTML = svgIcon(name, size);
    return host.firstElementChild as unknown as SVGSVGElement;
}
