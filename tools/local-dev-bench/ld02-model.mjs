import {withProductBroker} from './ld03-model.mjs';

const findTool = 'find_section';
const editTool = 'edit_section';
const line = value => typeof value === 'string' && value.length > 0 && Array.from(value).length <= 128
  && !/[\x00-\x1f\x7f]/.test(value);
const pixels = value => Number.isInteger(value) && value >= 0 && value <= 128;

export function withLD02Broker(path, {query, find, edit}, events, run) {
  let targetFound = false;
  let writeAttempted = false;
  return withProductBroker(path, async (name, args, event) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments');
    const keys = Object.keys(args).sort().join();
    const selector = {name: args.name, receipt: args.receipt};
    if (!line(selector.name) || typeof selector.receipt !== 'string' || !/^[A-Z]{2}-[0-9]{3}$/.test(selector.receipt)) {
      throw new Error('Expected a station name and receipt');
    }
    const isTarget = selector.name.toLowerCase() === query.name.toLowerCase() && selector.receipt === query.receipt;
    // The live lookup still has to return the unique native title and exact receipt.
    const nativeSelector = isTarget ? query : selector;
    event.arguments = args;
    if (name === findTool && keys === 'name,receipt') {
      event.status = 'running';
      const state = await find(nativeSelector);
      if (isTarget && state) targetFound = true;
      return state ?? {found: false};
    }
    if (name !== editTool || keys !== 'gap_px,name,radius_px,receipt,text' ||
        !line(args.text) || !pixels(args.gap_px) || !pixels(args.radius_px)) {
      throw new Error('Expected a station selector, status text, gap and radius');
    }
    if (!isTarget || !targetFound) throw new Error('Locate the permitted station by name and receipt before editing');
    if (writeAttempted) throw new Error('The station edit was already attempted');
    writeAttempted = true;
    event.status = 'running';
    return edit(nativeSelector, {text: args.text, gap: args.gap_px, radius: args.radius_px});
  }, events, run);
}
