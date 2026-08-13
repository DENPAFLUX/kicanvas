/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

class KiCanvasEvent<T> extends CustomEvent<T> {
    constructor(name: string, detail: T, bubbles = false) {
        super(name, { detail: detail, composed: true, bubbles: bubbles });
    }
}

export class KiCanvasLoadEvent extends KiCanvasEvent<null> {
    static readonly type = "kicanvas:load";

    constructor() {
        super(KiCanvasLoadEvent.type, null, true);
    }
}

/**
 * What the document means by a selected item, for embedders that work in nets
 * and parts rather than in KiCad items.
 */
export interface Selection {
    kind: "net" | "part" | "sheet";
    /** Net name, part reference designator, or sheet id, per `kind`. */
    name: string;
}

interface SelectDetails {
    item: unknown;
    previous: unknown;
    /** null when the item means nothing outside the document, and on deselect. */
    selection: Selection | null;
    /** A modifier key was held for the click that made this selection. */
    additive: boolean;
}

export class KiCanvasSelectEvent extends KiCanvasEvent<SelectDetails> {
    static readonly type = "kicanvas:select";

    constructor(detail: SelectDetails) {
        super(KiCanvasSelectEvent.type, detail, true);
    }
}

/** The project's active page changed, before the new page has loaded. */
export class KiCanvasSheetChangeEvent extends KiCanvasEvent<null> {
    static readonly type = "kicanvas:sheetchange";

    constructor() {
        super(KiCanvasSheetChangeEvent.type, null, true);
    }
}

/** The camera moved or the canvas resized, so anything drawn on top must follow. */
export class KiCanvasViewChangeEvent extends KiCanvasEvent<null> {
    static readonly type = "kicanvas:viewchange";

    constructor() {
        super(KiCanvasViewChangeEvent.type, null, true);
    }
}

interface MouseMoveDetails {
    x: number;
    y: number;
}

export class KiCanvasMouseMoveEvent extends KiCanvasEvent<MouseMoveDetails> {
    static readonly type = "kicanvas:mousemove";

    constructor(detail: MouseMoveDetails) {
        super(KiCanvasMouseMoveEvent.type, detail, true);
    }
}

// Event maps for type safe addEventListener.

export interface KiCanvasEventMap {
    [KiCanvasLoadEvent.type]: KiCanvasLoadEvent;
    [KiCanvasSelectEvent.type]: KiCanvasSelectEvent;
    [KiCanvasSheetChangeEvent.type]: KiCanvasSheetChangeEvent;
    [KiCanvasViewChangeEvent.type]: KiCanvasViewChangeEvent;
    [KiCanvasMouseMoveEvent.type]: KiCanvasMouseMoveEvent;
}

declare global {
    interface WindowEventMap {
        [KiCanvasLoadEvent.type]: KiCanvasLoadEvent;
        [KiCanvasSelectEvent.type]: KiCanvasSelectEvent;
            [KiCanvasSheetChangeEvent.type]: KiCanvasSheetChangeEvent;
            [KiCanvasViewChangeEvent.type]: KiCanvasViewChangeEvent;
    }

    interface HTMLElementEventMap {
        [KiCanvasLoadEvent.type]: KiCanvasLoadEvent;
        [KiCanvasSelectEvent.type]: KiCanvasSelectEvent;
            [KiCanvasSheetChangeEvent.type]: KiCanvasSheetChangeEvent;
            [KiCanvasViewChangeEvent.type]: KiCanvasViewChangeEvent;
    }
}
