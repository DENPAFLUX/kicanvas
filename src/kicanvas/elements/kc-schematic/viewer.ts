/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { SchematicViewer } from "../../../viewers/schematic/viewer";
import { KCViewerElement } from "../common/viewer";
import type { ProjectPage } from "../../project";

export class KCSchematicViewerElement extends KCViewerElement<SchematicViewer> {
    protected override update_theme(): void {
        this.viewer.theme = this.themeObject.schematic;
    }

    protected override make_viewer(): SchematicViewer {
        return new SchematicViewer(
            this.canvas,
            !this.disableinteraction,
            this.themeObject.schematic,
        );
    }

    // Pass the full ProjectPage (not src.document) so SchematicViewer.load
    // hits its ProjectPage branch, which sets this.document = null! and calls
    // update_hierarchical_data — ensuring kicanvas:load fires on every navigation,
    // including back to a previously-visited page.
    override async load(src: ProjectPage) {
        this.loaded = false;
        await this.viewer.load(src);
    }
}

window.customElements.define("kc-schematic-viewer", KCSchematicViewerElement);
