import { chromium, type Browser, type BrowserContext } from "playwright";
import type { RenderedStyles } from "../types.js";

/**
 * Headless renderer — extracts COMPUTED styles from live code components.
 * Uses a persistent browser context with ref-counted lifecycle to handle
 * concurrent requests safely under HTTP transport.
 */
export class RendererService {
  private browser: Browser | null = null;
  private activePages = 0;

  async getComputedStyles(
    componentUrl: string,
    selector: string
  ): Promise<RenderedStyles> {
    const context = await this.getContext();
    const page = await context.newPage();
    this.activePages++;

    try {
      await page.goto(componentUrl, { waitUntil: "networkidle", timeout: 20000 });

      // Wait for selector — throw a clear error if not found
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
      } catch {
        const bodyHtml = await page.evaluate(() => document.body.innerHTML.slice(0, 500));
        throw new Error(
          `Selector "${selector}" not found on ${componentUrl}.\n` +
          `Page preview: ${bodyHtml}\n` +
          `Tip: Check your css_selector — most Storybook stories use "#storybook-root > *" or the component's actual class/id.`
        );
      }

      const computed = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const styles = window.getComputedStyle(el);
        const relevant = [
          "padding-top", "padding-right", "padding-bottom", "padding-left",
          "margin-top", "margin-right", "margin-bottom", "margin-left",
          "background-color", "color", "border-radius",
          "font-size", "font-weight", "font-family", "line-height", "letter-spacing",
          "border-width", "border-style", "border-color",
          "box-shadow", "opacity", "gap", "width", "height",
          "text-transform",
        ];
        const result: Record<string, string> = {};
        for (const prop of relevant) {
          result[prop] = styles.getPropertyValue(prop);
        }
        return result;
      }, selector);

      if (!computed) throw new Error(`Selector "${selector}" matched but getComputedStyle returned null.`);

      const hoverStyles = await this.captureHoverStyles(page, selector);
      const focusStyles = await this.captureFocusStyles(page, selector);
      const disabledStyles = await this.captureDisabledStyles(page, selector);

      return {
        selector,
        computed,
        states: {
          ...(hoverStyles && { hover: hoverStyles }),
          ...(focusStyles && { focus: focusStyles }),
          ...(disabledStyles && { disabled: disabledStyles }),
        },
      };
    } finally {
      this.activePages--;
      await page.close();
    }
  }

  private async captureHoverStyles(
    page: import("playwright").Page,
    selector: string
  ): Promise<Record<string, string> | null> {
    try {
      await page.hover(selector, { timeout: 3000 });
      return await this.extractStateProps(page, selector);
    } catch {
      return null;
    }
  }

  private async captureFocusStyles(
    page: import("playwright").Page,
    selector: string
  ): Promise<Record<string, string> | null> {
    try {
      await page.focus(selector);
      return await this.extractStateProps(page, selector);
    } catch {
      return null;
    }
  }

  private async captureDisabledStyles(
    page: import("playwright").Page,
    selector: string
  ): Promise<Record<string, string> | null> {
    try {
      // Check if the element is actually disabled or has disabled class/aria
      const isDisabled = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        return (
          (el as HTMLButtonElement).disabled === true ||
          el.getAttribute("aria-disabled") === "true" ||
          el.classList.contains("disabled")
        );
      }, selector);

      if (!isDisabled) return null; // element not in disabled state — can't capture

      return await this.extractStateProps(page, selector);
    } catch {
      return null;
    }
  }

  private async extractStateProps(
    page: import("playwright").Page,
    selector: string
  ): Promise<Record<string, string> | null> {
    return page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const styles = window.getComputedStyle(el);
      return {
        "background-color": styles.getPropertyValue("background-color"),
        "color": styles.getPropertyValue("color"),
        "border-color": styles.getPropertyValue("border-color"),
        "opacity": styles.getPropertyValue("opacity"),
        "box-shadow": styles.getPropertyValue("box-shadow"),
      };
    }, selector);
  }

  private async getContext(): Promise<BrowserContext> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser.newContext();
  }

  async close(): Promise<void> {
    if (this.activePages > 0) {
      // Wait briefly for in-flight requests to finish
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await this.browser?.close();
    this.browser = null;
  }

  /**
   * Render at a specific viewport size — for responsive parity checks
   */
  async getComputedStylesAtViewport(
    componentUrl: string,
    selector: string,
    viewportWidth: number,
    viewportHeight: number
  ): Promise<import("../types.js").RenderedStyles> {
    const context = await this.getContext();
    const page = await context.newPage();
    this.activePages++;

    try {
      await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
      await page.goto(componentUrl, { waitUntil: "networkidle", timeout: 20000 });
      await page.waitForSelector(selector, { timeout: 10000 }).catch(() => {});

      const computed = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return {} as Record<string, string>;
        const styles = window.getComputedStyle(el);
        const props = [
          "width", "height", "min-width", "max-width",
          "padding-top", "padding-right", "padding-bottom", "padding-left",
          "font-size", "line-height", "overflow", "overflow-x",
          "display", "flex-direction", "flex-wrap",
          "background-color", "color", "visibility", "opacity",
        ];
        const result: Record<string, string> = {};
        for (const prop of props) result[prop] = styles.getPropertyValue(prop);
        return result;
      }, selector);

      return { selector, computed, states: {} };
    } finally {
      this.activePages--;
      await page.close();
    }
  }
}
