import {
    ASB_TOKEN_BASE_CLASS,
    ASB_TOKEN_NATIVE_SELECTION_CLASS,
    ASB_TOKEN_ON_CUE_HOVER_CLASS,
    ASB_TOKEN_ON_WORD_HOVER_CLASS,
    ASB_TOKEN_SELECTED_CLASS,
    hoverWordSelector,
} from '@project/common/annotations/dom-annotations';
import { createSubtitleCopyHandler } from '@project/common/annotations/dom-native-copy';

const hoverBranchSelector = `${hoverWordSelector} > :is(.${ASB_TOKEN_BASE_CLASS}, .${ASB_TOKEN_ON_CUE_HOVER_CLASS}, .${ASB_TOKEN_ON_WORD_HOVER_CLASS})`;

const hoverBranchFor = (node: Node | null) => {
    const element = node instanceof Element ? node : node?.parentElement;
    const branch = element?.closest(hoverBranchSelector);
    return branch?.parentElement?.classList.contains(ASB_TOKEN_SELECTED_CLASS) ? null : (branch ?? null);
};

const nativeSelectionBindings = new WeakMap<
    Document,
    { shadowRootSources: Set<() => readonly ShadowRoot[]>; dispose: () => void }
>();

export const bindNativeTokenSelection = (
    document: Document,
    getShadowRoots: () => readonly ShadowRoot[] = () => []
) => {
    let binding = nativeSelectionBindings.get(document);
    if (!binding) {
        const shadowRootSources = new Set<() => readonly ShadowRoot[]>();
        binding = {
            shadowRootSources,
            dispose: trackNativeTokenSelection(document, () =>
                Array.from(shadowRootSources).flatMap((roots) => roots())
            ),
        };
        nativeSelectionBindings.set(document, binding);
    }
    const source = () => getShadowRoots();
    binding.shadowRootSources.add(source);
    return () => {
        if (!binding.shadowRootSources.delete(source) || binding.shadowRootSources.size !== 0) return;
        binding.dispose();
        nativeSelectionBindings.delete(document);
    };
};

const appendSelectionEndpoints = (selection: Selection | null | undefined, endpoints: (Node | null)[]) => {
    if (selection && !selection.isCollapsed) endpoints.push(selection.anchorNode, selection.focusNode);
};

const nativeTokenSelection = (document: Document, shadowRoots: readonly ShadowRoot[]) => {
    const selection:
        | (Selection & { getComposedRanges?: (options: { shadowRoots: readonly ShadowRoot[] }) => StaticRange[] })
        | null = document.getSelection();
    if (!selection?.rangeCount) return;

    // Document-level endpoints can be retargeted to a shadow host rather than the selected text.
    if (shadowRoots.length && selection.getComposedRanges) {
        return { composedRanges: selection.getComposedRanges({ shadowRoots }) };
    }

    const selections = [selection];
    for (const root of shadowRoots) {
        const shadowRoot: ShadowRoot & { getSelection?: () => Selection | null } = root;
        const rootSelection = shadowRoot.getSelection?.();
        if (rootSelection) selections.push(rootSelection);
    }
    return { selections };
};

const nativeSelectionEndpoints = (document: Document, shadowRoots: readonly ShadowRoot[]) => {
    const native = nativeTokenSelection(document, shadowRoots);
    if (!native) return [];
    if (native.composedRanges) {
        return native.composedRanges.flatMap((range) =>
            range.collapsed ? [] : [range.startContainer, range.endContainer]
        );
    }
    const endpoints: (Node | null)[] = [];
    for (const selection of native.selections) appendSelectionEndpoints(selection, endpoints);
    return endpoints;
};

const nativeCopyRange = (document: Document, shadowRoots: readonly ShadowRoot[]) => {
    const native = nativeTokenSelection(document, shadowRoots);
    if (!native) return;
    if (native.composedRanges) return native.composedRanges.length === 1 ? native.composedRanges[0] : undefined;
    const selections = native.selections.filter((selection) => !selection.isCollapsed);
    if (selections.length === 1 && selections[0].rangeCount === 1) return selections[0].getRangeAt(0);
};

const trackNativeTokenSelection = (document: Document, getShadowRoots: () => readonly ShadowRoot[]) => {
    let pressedBranch: Element | null = null;
    let pinned = new Set<Element>();

    const sync = () => {
        const endpoints = new Map<Element, Element>();
        const pin = (branch: Element | null) => {
            const word = branch?.parentElement;
            if (branch?.isConnected && word && !endpoints.has(word)) endpoints.set(word, branch);
        };
        pin(pressedBranch); // Pin before the browser starts dragging, so the first mouse move cannot hide the anchor
        for (const node of nativeSelectionEndpoints(document, getShadowRoots())) {
            pin(hoverBranchFor(node));
        }
        const branches = new Set(endpoints.values());
        for (const branch of pinned) {
            if (!branches.has(branch)) branch.classList.remove(ASB_TOKEN_NATIVE_SELECTION_CLASS);
        }
        for (const branch of branches) {
            if (!pinned.has(branch)) branch.classList.add(ASB_TOKEN_NATIVE_SELECTION_CLASS);
        }
        pinned = branches;
    };

    const press = (event: MouseEvent) => {
        if (event.button !== 0) return;
        const target = event.composedPath()[0];
        pressedBranch = target instanceof Node ? hoverBranchFor(target) : null;
        if (pressedBranch || pinned.size) sync();
    };
    const release = () => {
        if (!pressedBranch) return;
        pressedBranch = null;
        sync();
    };
    const copy = createSubtitleCopyHandler(document, () => nativeCopyRange(document, getShadowRoots()));

    document.addEventListener('mousedown', press, true);
    document.addEventListener('mouseup', release, true);
    document.addEventListener('selectionchange', sync);
    document.addEventListener('copy', copy);
    document.defaultView?.addEventListener('blur', release);
    return () => {
        document.removeEventListener('mousedown', press, true);
        document.removeEventListener('mouseup', release, true);
        document.removeEventListener('selectionchange', sync);
        document.removeEventListener('copy', copy);
        document.defaultView?.removeEventListener('blur', release);
        for (const branch of pinned) branch.classList.remove(ASB_TOKEN_NATIVE_SELECTION_CLASS);
    };
};
