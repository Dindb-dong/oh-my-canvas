// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createInspectorHelp} from '../ui/inspector-help';
import {button, input, select, check, section} from '../ui/dom';
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });
it('shows delayed contextual help on field labels and restores existing descriptions and native titles', () => {
    vi.useFakeTimers();
    const root = section('Geometry'), field = input('X', 12, () => {}, 'number');
    root.append(field); document.body.append(root);
    const control = field.querySelector('input')!;
    control.title = 'X'; control.setAttribute('aria-describedby', 'existing');
    const help = createInspectorHelp(root);
    field.querySelector('span')!.dispatchEvent(new Event('pointerover', {bubbles:true}));
    expect(document.querySelector('[role=tooltip]')).toBeNull();
    vi.advanceTimersByTime(450);
    expect(document.querySelector('[role=tooltip]')?.textContent).toContain('Horizontal position');
    expect(control.getAttribute('aria-describedby')).toContain('existing inspector-help-');
    expect(control.hasAttribute('title')).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}));
    expect(document.querySelector('[role=tooltip]')).toBeNull();
    expect(control.title).toBe('X');
    expect(control.getAttribute('aria-describedby')).toBe('existing');
    help.destroy();
});
it('covers dynamically added buttons, selects and checkboxes on keyboard focus, then cleans up', () => {
    const root = section('Typography'); document.body.append(root);
    const help = createInspectorHelp(root);
    root.append(button('More', () => {}), select('Align', 'center', ['center'], () => {}), check('Truncate', false, () => {}));
    for (const control of root.querySelectorAll<HTMLElement>('button,select,input')) {
        control.focus();
        expect(document.querySelector('[role=tooltip]')?.textContent).toBeTruthy();
        expect(control.getAttribute('aria-describedby')).toContain('inspector-help-');
    }
    root.querySelector('select')!.focus();
    expect(document.querySelector('[role=tooltip]')?.textContent).toContain('Align text horizontally');
    root.dispatchEvent(new Event('scroll'));
    expect(document.querySelector('[role=tooltip]')).toBeNull();
    help.destroy(); root.querySelector('button')!.focus();
    expect(document.querySelector('[role=tooltip]')).toBeNull();
});
it('preserves a disabled action’s specific availability explanation', () => {
    vi.useFakeTimers();
    const root = section('Image'), control = button('Remove background', () => {});
    control.disabled = true; control.title = 'Background removal is unavailable on this platform';
    root.append(control); document.body.append(root);
    const help = createInspectorHelp(root);
    control.dispatchEvent(new Event('pointerover', {bubbles:true})); vi.advanceTimersByTime(450);
    expect(document.querySelector('[role=tooltip]')?.textContent).toContain('unavailable on this platform');
    help.destroy();
});
