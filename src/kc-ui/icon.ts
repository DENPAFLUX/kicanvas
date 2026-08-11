/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { css, html, literal } from "../base/web-components";
import { KCUIElement } from "./element";

/**
 * kc-ui-icon is a material symbol
 */
export class KCUIIconElement extends KCUIElement {
    /**
     * Sprite sheet markup, i.e. the `<symbol>` definitions. Consumers must set
     * this before any `svg:`-prefixed icon renders, or that icon draws nothing.
     */
    public static sprites_source: string = "";

    static #symbols: Map<string, string> = new Map();
    static #symbols_source: string | null = null;

    static #symbol(name: string): string {
        if (KCUIIconElement.#symbols_source !== KCUIIconElement.sprites_source) {
            KCUIIconElement.#symbols_source = KCUIIconElement.sprites_source;
            KCUIIconElement.#symbols = new Map(
                Array.from(
                    new DOMParser()
                        .parseFromString(
                            KCUIIconElement.sprites_source,
                            "image/svg+xml",
                        )
                        .querySelectorAll("symbol"),
                    (symbol) => [symbol.id, symbol.outerHTML],
                ),
            );
        }

        return KCUIIconElement.#symbols.get(name) ?? "";
    }

    static override styles = [
        css`
            :host {
                box-sizing: border-box;
                font-family: "Material Symbols Outlined";
                font-weight: normal;
                font-style: normal;
                font-size: inherit;
                line-height: 1;
                letter-spacing: normal;
                text-transform: none;
                white-space: nowrap;
                word-wrap: normal;
                direction: ltr;
                -webkit-font-feature-settings: "liga";
                -moz-font-feature-settings: "liga";
                font-feature-settings: "liga";
                -webkit-font-smoothing: antialiased;
                user-select: none;
            }

            svg {
                width: 1.2em;
                height: auto;
                fill: currentColor;
            }
        `,
    ];

    override render() {
        const text = this.textContent ?? "";
        if (text.startsWith("svg:")) {
            const name = text.slice(4);
            // The symbol is inlined rather than referenced across documents:
            // a `<use>` into the sprite document resolves its `fill` there, so
            // `currentColor` would never see this element's colour.
            return html`<svg viewBox="0 0 48 48" width="48">
                ${literal`${KCUIIconElement.#symbol(name)}`}
                <use xlink:href="#${name}" />
            </svg>`;
        } else {
            return html`<slot></slot>`;
        }
    }
}

window.customElements.define("kc-ui-icon", KCUIIconElement);
