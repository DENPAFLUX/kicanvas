/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { first } from "../../base/iterator";
import { BBox, Vec2 } from "../../base/math";
import { is_string } from "../../base/types";
import { Color, Polygon, Polyline, Renderer } from "../../graphics";
import { Canvas2DRenderer } from "../../graphics/canvas2d";
import type { SchematicTheme } from "../../kicad";
import {
    DefaultValues,
    KicadSch,
    NetLabel,
    GlobalLabel,
    HierarchicalLabel,
    SchematicSheet,
    SchematicSymbol,
    Wire,
    Bus,
} from "../../kicad/schematic";
import type { ProjectPage } from "../../kicanvas/project";
import { DocumentViewer } from "../base/document-viewer";
import { LayerNames, LayerSet } from "./layers";
import { SchematicPainter } from "./painter";

// KiCad net highlight colour – bright cyan, matching the desktop app.
const NET_HIGHLIGHT_COLOR = new Color(0, 0.816, 1, 1); // #00d0ff
// Stroke width used when drawing net highlight lines on the overlay.
const NET_HIGHLIGHT_STROKE = DefaultValues.wire_width * 3;

export class SchematicViewer extends DocumentViewer<
    KicadSch,
    SchematicPainter,
    LayerSet,
    SchematicTheme
> {
    /** The currently highlighted net name, or null if none. */
    #highlighted_net: string | null = null;

    get schematic(): KicadSch {
        return this.document;
    }

    override create_renderer(canvas: HTMLCanvasElement): Renderer {
        const renderer = new Canvas2DRenderer(canvas);
        renderer.state.fill = this.theme.note;
        renderer.state.stroke = this.theme.note;
        renderer.state.stroke_width = 0.1524;
        return renderer;
    }

    override async load(src: KicadSch | ProjectPage) {
        if (src instanceof KicadSch) {
            return await super.load(src);
        }

        this.document = null!;

        const doc = src.document as KicadSch;
        doc.update_hierarchical_data(src.sheet_path);

        return await super.load(doc);
    }

    protected override create_painter() {
        return new SchematicPainter(this.renderer, this.layers, this.theme);
    }

    protected override create_layer_set() {
        return new LayerSet(this.theme);
    }

    public override select(
        item:
            | SchematicSymbol
            | SchematicSheet
            | Wire
            | Bus
            | NetLabel
            | GlobalLabel
            | HierarchicalLabel
            | string
            | BBox
            | null,
    ): void {
        // If item is a string, find the symbol, sheet, or net label by uuid/reference/name.
        if (is_string(item)) {
            item =
                this.schematic.find_symbol(item) ??
                this.schematic.find_sheet(item) ??
                this.schematic.find_net_label(item);
        }

        // If it's a symbol or sheet, find the bounding box for it.
        if (item instanceof SchematicSymbol || item instanceof SchematicSheet) {
            const bboxes = this.layers.query_item_bboxes(item);
            item = first(bboxes) ?? null;
        }

        // If it's a net item, resolve the net name and store it for painting,
        // then find a representative bounding box for the base class.
        if (
            item instanceof Wire ||
            item instanceof Bus ||
            item instanceof NetLabel ||
            item instanceof GlobalLabel ||
            item instanceof HierarchicalLabel
        ) {
            const net_name =
                item instanceof Wire || item instanceof Bus
                    ? null
                    : item.text;
            this.#highlighted_net = net_name;
            const bboxes = this.layers.query_item_bboxes(item);
            item = first(bboxes) ?? null;
        } else {
            // Symbol, sheet, null, or BBox — clear net highlight.
            this.#highlighted_net = null;
        }

        super.select(item);
    }

    /**
     * Highlight all schematic items belonging to the named net.
     * Can be called externally for cross-probing without going through select().
     * Pass null to clear the net highlight.
     */
    public highlight_net(name: string | null) {
        this.#highlighted_net = name;
        // Bypass super.select() to avoid triggering KiCanvasSelectEvent; just
        // repaint directly.
        this._paint_net_highlight();
    }

    protected override paint_selected() {
        if (this.#highlighted_net !== null) {
            this._paint_net_highlight();
        } else {
            // Clear layer highlights that may have been set by a previous net selection.
            this._clear_net_layer_highlights();
            super.paint_selected();
        }
    }

    private _clear_net_layer_highlights() {
        this.layers.highlight(null);
    }

    private _paint_net_highlight() {
        const net_name = this.#highlighted_net;
        const overlay = this.layers.overlay;
        overlay.clear();

        if (!net_name || !this.schematic) {
            this._clear_net_layer_highlights();
            this.draw();
            return;
        }

        // Dim everything except the wire and label layers by marking them as
        // highlighted. The base on_draw() will render non-highlighted layers at
        // 25% alpha when any layer is highlighted.
        this.layers.highlight([
            LayerNames.wire,
            LayerNames.label,
            LayerNames.junction,
        ]);

        // Collect all wire/bus/label items that belong to this net name.
        // Strategy: find all labels with matching text, then flood-fill connected
        // wires/buses via shared endpoints (±tolerance). This matches KiCad desktop
        // behaviour without a full netlist solver.
        const TOLERANCE = 0.01; // mm — KiCad snaps to 25mil ≈ 0.635 mm grid
        const interactive_layer = this.layers.by_name(LayerNames.interactive)!;

        const matching_labels: Array<NetLabel | GlobalLabel | HierarchicalLabel> = [];
        const all_wires: Array<Wire | Bus> = [];

        for (const [item] of interactive_layer.bboxes) {
            if (
                (item instanceof NetLabel ||
                    item instanceof GlobalLabel ||
                    item instanceof HierarchicalLabel) &&
                item.text === net_name
            ) {
                matching_labels.push(item);
            } else if (item instanceof Wire || item instanceof Bus) {
                all_wires.push(item);
            }
        }

        // Flood-fill: start from every label endpoint, walk connected wires.
        const pts_close = (a: Vec2, b: Vec2) =>
            Math.abs(a.x - b.x) < TOLERANCE && Math.abs(a.y - b.y) < TOLERANCE;

        const connected_wires = new Set<Wire | Bus>();
        const frontier: Vec2[] = matching_labels.map((l) => l.at.position);
        const visited_pts: Vec2[] = [];

        while (frontier.length > 0) {
            const pt = frontier.pop()!;
            if (visited_pts.some((v) => pts_close(v, pt))) continue;
            visited_pts.push(pt);

            for (const wire of all_wires) {
                if (connected_wires.has(wire)) continue;
                const [p0, p1] = wire.pts;
                if (
                    (p0 && pts_close(p0, pt)) ||
                    (p1 && pts_close(p1, pt))
                ) {
                    connected_wires.add(wire);
                    // Expand frontier from the other endpoint.
                    if (p0 && pts_close(p0, pt) && p1) frontier.push(p1);
                    if (p1 && pts_close(p1, pt) && p0) frontier.push(p0);
                }
            }
        }

        // Build final list of bboxes to highlight.
        const bboxes: BBox[] = [];

        for (const label of matching_labels) {
            const bbox = interactive_layer.bboxes.get(label);
            if (bbox) bboxes.push(bbox);
        }
        for (const wire of connected_wires) {
            const bbox = interactive_layer.bboxes.get(wire);
            if (bbox) bboxes.push(bbox);
        }

        if (bboxes.length === 0) {
            this._clear_net_layer_highlights();
            this.draw();
            return;
        }

        // Draw highlight strokes for every matching item on the overlay layer.
        this.renderer.start_layer(overlay.name);

        for (const bbox of bboxes) {
            const item = bbox.context;
            if (item instanceof Wire || item instanceof Bus) {
                // Re-draw the wire segment in the highlight colour.
                this.renderer.line(
                    new Polyline(
                        item.pts,
                        NET_HIGHLIGHT_STROKE,
                        NET_HIGHLIGHT_COLOR,
                    ),
                );
            } else if (
                item instanceof NetLabel ||
                item instanceof GlobalLabel ||
                item instanceof HierarchicalLabel
            ) {
                // Draw a filled highlight rect behind the label.
                const bb = bbox.copy().grow(0.3);
                this.renderer.polygon(Polygon.from_BBox(bb, NET_HIGHLIGHT_COLOR));
            }
        }

        overlay.graphics = this.renderer.end_layer();
        overlay.graphics.composite_operation = "overlay";

        this.draw();
    }
}
