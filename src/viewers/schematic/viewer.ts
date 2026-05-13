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
    Junction,
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
import { type ViewLayerSet } from "../base/view-layers";
import { LayerNames, LayerSet } from "./layers";
import { SchematicPainter } from "./painter";

/**
 * Returns the schematic-space connection points for all pins of a symbol.
 *
 * Power symbols (and Eagle-imported symbols) often have their pin at a local
 * position other than (0, 0), so sym.at.position is NOT the wire endpoint.
 * We replicate the same 2×2 rotation+mirror matrix used by get_symbol_transform
 * in symbol.ts to convert each pin's local position to schematic coordinates.
 */
function sym_pin_positions(sym: SchematicSymbol): Vec2[] {
    let x1: number, x2: number, y1: number, y2: number;
    switch (sym.at.rotation) {
        case 90:  x1 = 0;  x2 = -1; y1 = -1; y2 = 0;  break;
        case 180: x1 = -1; x2 = 0;  y1 = 0;  y2 = 1;  break;
        case 270: x1 = 0;  x2 = 1;  y1 = 1;  y2 = 0;  break;
        default:  x1 = 1;  x2 = 0;  y1 = 0;  y2 = -1; break; // 0°
    }
    if (sym.mirror === "y")      { x1 = -x1; y1 = -y1; }
    else if (sym.mirror === "x") { x2 = -x2; y2 = -y2; }

    const lib = sym.lib_symbol;
    if (!lib) return [];

    const unit_num = sym.unit ?? 1;
    const positions: Vec2[] = [];
    for (const k of unit_num === 0 ? [0] : [0, unit_num]) {
        for (const unit_sym of lib.units.get(k) ?? []) {
            for (const pin of unit_sym.pins) {
                const lx = pin.at.position.x;
                const ly = pin.at.position.y;
                positions.push(new Vec2(
                    sym.at.position.x + x1 * lx + x2 * ly,
                    sym.at.position.y + y1 * lx + y2 * ly,
                ));
            }
        }
    }
    return positions;
}

interface NetEntry {
    wires: Set<Wire | Bus>;
    labels: Array<NetLabel | GlobalLabel | HierarchicalLabel>;
    power_syms: SchematicSymbol[];
}

interface NetMap {
    by_name: Map<string, NetEntry>;
    /** Fast reverse lookup: wire/bus → net name */
    wire_to_net: Map<Wire | Bus, string>;
}

/**
 * Builds a full connectivity map from a KiCad schematic using union-find.
 *
 * Handles: wire endpoint chains, T-junctions (via junction items), labels
 * placed at wire interior points (not just endpoints), power symbols with
 * pins offset from the symbol origin.
 *
 * Unlabeled connected components are assigned N$1, N$2, … names in wire
 * order (same convention KiCad uses in its netlister).
 */
function build_net_map(schematic: KicadSch): NetMap {
    const TOLERANCE = 0.01; // mm — KiCad snaps to 25mil ≈ 0.635mm grid

    // Quantise coordinates so floating-point drift doesn't split the same
    // physical point into two union-find nodes.
    const inv = 1 / TOLERANCE;
    const key = (v: Vec2) =>
        `${Math.round(v.x * inv)},${Math.round(v.y * inv)}`;

    // ── Union-Find ────────────────────────────────────────────────────────
    const parent = new Map<string, string>();

    const find = (k: string): string => {
        if (!parent.has(k)) parent.set(k, k);
        let root = k;
        while (parent.get(root) !== root) root = parent.get(root)!;
        // path compression
        let cur = k;
        while (cur !== root) {
            const nxt = parent.get(cur)!;
            parent.set(cur, root);
            cur = nxt;
        }
        return root;
    };

    const find_v = (v: Vec2) => find(key(v));

    const union_v = (a: Vec2, b: Vec2) => {
        const ra = find_v(a);
        const rb = find_v(b);
        if (ra !== rb) parent.set(ra, rb);
    };

    const init_v = (v: Vec2) => {
        const k = key(v);
        if (!parent.has(k)) parent.set(k, k);
    };

    // ── Geometry helpers ─────────────────────────────────────────────────
    const pts_close = (a: Vec2, b: Vec2) =>
        Math.abs(a.x - b.x) < TOLERANCE && Math.abs(a.y - b.y) < TOLERANCE;

    const on_segment = (p: Vec2, p0: Vec2, p1: Vec2): boolean => {
        if (Math.abs(p1.x - p0.x) < TOLERANCE) {
            if (Math.abs(p.x - p0.x) > TOLERANCE) return false;
            return (
                p.y >= Math.min(p0.y, p1.y) - TOLERANCE &&
                p.y <= Math.max(p0.y, p1.y) + TOLERANCE
            );
        }
        if (Math.abs(p1.y - p0.y) < TOLERANCE) {
            if (Math.abs(p.y - p0.y) > TOLERANCE) return false;
            return (
                p.x >= Math.min(p0.x, p1.x) - TOLERANCE &&
                p.x <= Math.max(p0.x, p1.x) + TOLERANCE
            );
        }
        const t = (p.x - p0.x) / (p1.x - p0.x);
        if (t < -TOLERANCE || t > 1 + TOLERANCE) return false;
        return Math.abs(p0.y + t * (p1.y - p0.y) - p.y) < TOLERANCE;
    };

    /** Connect point `p` to any wire whose endpoint or interior passes through it. */
    const connect_to_wires = (p: Vec2, all_wires: (Wire | Bus)[]) => {
        for (const wire of all_wires) {
            const [p0, p1] = wire.pts;
            if (!p0 || !p1) continue;
            if (pts_close(p, p0) || pts_close(p, p1) || on_segment(p, p0, p1)) {
                init_v(p);
                union_v(p, p0);
                // p0 and p1 already unioned in Phase 1
            }
        }
    };

    // ── Phase 1: union wire endpoints ─────────────────────────────────────
    const all_wires: (Wire | Bus)[] = [
        ...schematic.wires,
        ...schematic.buses,
    ];

    for (const wire of all_wires) {
        const [p0, p1] = wire.pts;
        if (p0 && p1) {
            init_v(p0);
            init_v(p1);
            union_v(p0, p1);
        }
    }

    // ── Phase 2: junctions connect T-intersecting wires ───────────────────
    for (const junc of schematic.junctions) {
        connect_to_wires(junc.at.position, all_wires);
    }

    // ── Phase 3: labels (including mid-wire placement) ────────────────────
    const all_labels: (NetLabel | GlobalLabel | HierarchicalLabel)[] = [
        ...schematic.net_labels,
        ...schematic.global_labels,
        ...schematic.hierarchical_labels,
    ];

    for (const label of all_labels) {
        connect_to_wires(label.at.position, all_wires);
    }

    // ── Phase 4: power symbol pins ────────────────────────────────────────
    for (const sym of schematic.symbols.values()) {
        if (!sym.lib_symbol?.power) continue;
        const pts = sym_pin_positions(sym);
        if (pts.length === 0) pts.push(sym.at.position);
        for (const pp of pts) connect_to_wires(pp, all_wires);
    }

    // ── Assign net names ──────────────────────────────────────────────────
    const comp_name = new Map<string, string>(); // root key → net name

    for (const label of all_labels) {
        const root = find_v(label.at.position);
        if (!comp_name.has(root)) comp_name.set(root, label.text);
    }

    for (const sym of schematic.symbols.values()) {
        if (!sym.lib_symbol?.power) continue;
        const pts = sym_pin_positions(sym);
        if (pts.length === 0) pts.push(sym.at.position);
        const root = find_v(pts[0]!);
        if (!comp_name.has(root)) comp_name.set(root, sym.value);
    }

    // Unnamed components → N$xx (KiCad convention)
    let unnamed = 1;
    for (const wire of all_wires) {
        const [p0] = wire.pts;
        if (!p0) continue;
        const root = find_v(p0);
        if (!comp_name.has(root)) comp_name.set(root, `N$${unnamed++}`);
    }

    // ── Build NetMap ──────────────────────────────────────────────────────
    const by_name = new Map<string, NetEntry>();
    const wire_to_net = new Map<Wire | Bus, string>();

    const entry = (name: string): NetEntry => {
        if (!by_name.has(name)) {
            by_name.set(name, { wires: new Set(), labels: [], power_syms: [] });
        }
        return by_name.get(name)!;
    };

    for (const wire of all_wires) {
        const [p0] = wire.pts;
        if (!p0) continue;
        const name = comp_name.get(find_v(p0));
        if (name) {
            entry(name).wires.add(wire);
            wire_to_net.set(wire, name);
        }
    }

    for (const label of all_labels) {
        const name = comp_name.get(find_v(label.at.position)) ?? label.text;
        entry(name).labels.push(label);
    }

    for (const sym of schematic.symbols.values()) {
        if (!sym.lib_symbol?.power) continue;
        const pts = sym_pin_positions(sym);
        if (pts.length === 0) pts.push(sym.at.position);
        const name = comp_name.get(find_v(pts[0]!)) ?? sym.value;
        entry(name).power_syms.push(sym);
    }

    return { by_name, wire_to_net };
}

// Net highlight colours – vivid yellow fill + solid outline.
const NET_HIGHLIGHT_COLOR = new Color(1, 0.88, 0, 1);       // #FFE000 solid
const NET_HIGHLIGHT_FILL  = new Color(1, 0.88, 0, 0.30);    // #FFE000 semi-transparent
const NET_HIGHLIGHT_OUTLINE_WIDTH = 0.18;                    // outline stroke (mm)
// Stroke width used when drawing net highlight lines on the overlay.
const NET_HIGHLIGHT_STROKE = DefaultValues.wire_width * 4;

export class SchematicViewer extends DocumentViewer<
    KicadSch,
    SchematicPainter,
    LayerSet,
    SchematicTheme
> {
    /** The currently highlighted net name, or null if none. */
    #highlighted_net: string | null = null;

    /** Net connectivity map built once after load. */
    #net_map: NetMap | null = null;

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
            const result = await super.load(src);
            this.#net_map = build_net_map(this.schematic);
            return result;
        }

        this.document = null!;

        const doc = src.document as KicadSch;
        doc.update_hierarchical_data(src.sheet_path);

        const result = await super.load(doc);
        this.#net_map = build_net_map(this.schematic);
        return result;
    }

    protected override create_painter() {
        return new SchematicPainter(this.renderer, this.layers, this.theme);
    }

    protected override create_layer_set() {
        return new LayerSet(this.theme);
    }

    // Wires and buses render as ~1 px strokes, so their bboxes are nearly
    // zero-height (or zero-width for vertical runs). Expand the hit area on a
    // second pass so they are easy to click without pixel-perfect aim.
    //
    // We also prioritise wires and labels over regular component symbols so that
    // clicking a pin stub area (which is rendered as part of the symbol, not a
    // separate Wire item) still reaches the net label placed at the pin endpoint.
    protected override on_pick(
        mouse: Vec2,
        items: ReturnType<ViewLayerSet["query_point"]>,
    ) {
        const is_structural = (ctx: unknown) =>
            ctx instanceof SchematicSymbol &&
            !ctx.lib_symbol.power &&
            (ctx.reference?.startsWith("#") ?? false);

        const is_regular_symbol = (ctx: unknown) =>
            ctx instanceof SchematicSymbol && !ctx.lib_symbol.power;

        // First pass: exact hit, but defer regular component symbols.
        // Labels, wires, power symbols, and junctions are selected immediately;
        // a regular symbol is only used if nothing better is found.
        let symbol_exact: BBox | null = null;
        for (const { bbox } of items) {
            if (is_structural(bbox.context)) continue;
            if (is_regular_symbol(bbox.context)) {
                if (!symbol_exact) symbol_exact = bbox;
                continue;
            }
            this.select(bbox.context ?? bbox);
            return;
        }

        // Second pass: expanded hit.
        // Net labels get a larger radius (LABEL_RADIUS) to cover the full
        // standard 0.1" / 2.54 mm pin stub so that clicking the stub area
        // near a pin still resolves to the net label.
        // Wires/buses use a smaller WIRE_RADIUS (fine-grained click tolerance).
        // Regular symbols are saved as a fallback but not selected immediately.
        const WIRE_RADIUS = 0.5;
        const LABEL_RADIUS = 2.6; // slightly > 2.54 mm standard pin stub
        let symbol_expanded: BBox | null = null;

        for (const layer of this.layers.interactive_layers()) {
            for (const [, bbox] of layer.bboxes) {
                if (is_structural(bbox.context)) continue;
                const ctx = bbox.context;
                if (is_regular_symbol(ctx)) {
                    if (!symbol_expanded && bbox.grow(WIRE_RADIUS).contains_point(mouse)) {
                        symbol_expanded = bbox;
                    }
                    continue;
                }
                const radius =
                    ctx instanceof Wire || ctx instanceof Bus
                        ? WIRE_RADIUS
                        : LABEL_RADIUS;
                if (bbox.grow(radius).contains_point(mouse)) {
                    this.select(ctx ?? bbox);
                    return;
                }
            }
        }

        // Fall back to component symbol (exact hit preferred over expanded hit).
        const hit = symbol_exact ?? symbol_expanded;
        if (hit) {
            this.select(hit.context ?? hit);
            return;
        }

        this.select(null);
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

        // Power port symbols act as net labels: highlight by value, not by reference.
        if (item instanceof SchematicSymbol && item.lib_symbol.power) {
            this.#highlighted_net = item.value;
            const bboxes = this.layers.query_item_bboxes(item);
            const bbox = first(bboxes) ?? null;
            super.select(bbox);
            return;
        }

        // If it's a symbol or sheet, find the bounding box for it.
        if (item instanceof SchematicSymbol || item instanceof SchematicSheet) {
            const bboxes = this.layers.query_item_bboxes(item);
            item = first(bboxes) ?? null;
        }

        // Wire/Bus: look up the net in the pre-built map and set the highlight.
        if (item instanceof Wire || item instanceof Bus) {
            const net_name = this.#net_map?.wire_to_net.get(item) ?? null;
            if (net_name) {
                this.#highlighted_net = net_name;
                // Try to anchor the selection box to the first label or power sym.
                const entry = this.#net_map?.by_name.get(net_name);
                const anchor = entry?.labels[0] ?? entry?.power_syms[0] ?? null;
                if (anchor) {
                    const bboxes = this.layers.query_item_bboxes(anchor);
                    super.select(first(bboxes) ?? null);
                } else {
                    super.select(null);
                }
            } else {
                this.#highlighted_net = null;
                super.select(null);
            }
            return;
        }

        // Net labels: store the net name and find the bounding box.
        if (
            item instanceof NetLabel ||
            item instanceof GlobalLabel ||
            item instanceof HierarchicalLabel
        ) {
            this.#highlighted_net = item.text;
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

        if (!net_name || !this.schematic || !this.#net_map) {
            this._clear_net_layer_highlights();
            this.draw();
            return;
        }

        this._clear_net_layer_highlights();

        const net_entry = this.#net_map.by_name.get(net_name);
        if (!net_entry) {
            this.draw();
            return;
        }

        const interactive_layer = this.layers.by_name(LayerNames.interactive)!;
        const bboxes: BBox[] = [];

        for (const wire of net_entry.wires) {
            const bbox = interactive_layer.bboxes.get(wire);
            if (bbox) bboxes.push(bbox);
        }
        for (const label of net_entry.labels) {
            const bbox = interactive_layer.bboxes.get(label);
            if (bbox) bboxes.push(bbox);
        }
        for (const sym of net_entry.power_syms) {
            const bbox = interactive_layer.bboxes.get(sym);
            if (bbox) bboxes.push(bbox);
        }

        if (bboxes.length === 0) {
            this.draw();
            return;
        }

        this.renderer.start_layer(overlay.name);

        for (const bbox of bboxes) {
            const item = bbox.context;
            if (item instanceof Wire || item instanceof Bus) {
                this.renderer.line(
                    new Polyline(item.pts, NET_HIGHLIGHT_STROKE, NET_HIGHLIGHT_COLOR),
                );
            } else if (
                item instanceof NetLabel ||
                item instanceof GlobalLabel ||
                item instanceof HierarchicalLabel ||
                (item instanceof SchematicSymbol && item.lib_symbol.power)
            ) {
                const bb = bbox.copy().grow(0.3);
                this.renderer.polygon(Polygon.from_BBox(bb, NET_HIGHLIGHT_FILL));
                this.renderer.line(
                    new Polyline(
                        [bb.top_left, bb.top_right, bb.bottom_right, bb.bottom_left, bb.top_left],
                        NET_HIGHLIGHT_OUTLINE_WIDTH,
                        NET_HIGHLIGHT_COLOR,
                    ),
                );
            }
        }

        overlay.graphics = this.renderer.end_layer();
        this.draw();
    }
}
