import axios, { type AxiosInstance } from "axios";
import { FIGMA_API_BASE } from "../constants.js";
import type { FigmaNodeSpec, DesignTokenMap, SpacingSpec, StateSpec, TokenValue } from "../types.js";

export class FigmaService {
  private client: AxiosInstance;

  constructor(apiKey: string) {
    this.client = axios.create({
      baseURL: FIGMA_API_BASE,
      headers: { "X-Figma-Token": apiKey },
      timeout: 15000,
    });
  }

  async getNodeSpec(fileId: string, nodeId: string): Promise<FigmaNodeSpec> {
    // BUG FIX: Figma node IDs contain ":" which must be URL-encoded
    const encodedNodeId = encodeURIComponent(nodeId);

    const [nodeResp, varResp] = await Promise.all([
      this.client.get(`/files/${fileId}/nodes?ids=${encodedNodeId}&geometry=paths`),
      this.client.get(`/files/${fileId}/variables/local`)
        .catch(() => ({ data: { meta: { variables: {} } } })),
    ]);

    // Figma returns the node keyed by the ORIGINAL (non-encoded) id
    const node = nodeResp.data.nodes[nodeId]?.document;
    if (!node) {
      throw new Error(
        `Node "${nodeId}" not found in file "${fileId}".\n` +
        `Verify the node ID in Figma: right-click the component → Copy/Paste → Copy link, ` +
        `then extract the node-id param from the URL.`
      );
    }

    const variables = varResp.data.meta?.variables ?? {};
    return this.parseNode(node, variables);
  }

  async getFileCodeConnectMappings(fileId: string): Promise<Array<{
    nodeId: string;
    componentName: string;
    lastModified: string;
    codeConnectPath?: string;
  }>> {
    const resp = await this.client.get(`/files/${fileId}/components`);
    const components = resp.data.meta?.components ?? [];

    return components.map((c: Record<string, unknown>) => ({
      nodeId: c.node_id as string,
      componentName: c.name as string,
      lastModified: c.updated_at as string,
      // Code Connect paths come from the local .figma/code-connect.json file,
      // not the API. This field will be populated by GitService after cross-referencing.
      codeConnectPath: undefined,
    }));
  }

  private parseNode(node: Record<string, unknown>, variables: Record<string, unknown>): FigmaNodeSpec {
    // Determine if this node is a COMPONENT_SET (has variant children) or a plain COMPONENT
    const isComponentSet = node.type === "COMPONENT_SET";
    return {
      nodeId: node.id as string,
      name: node.name as string,
      componentKey: node.componentId as string | undefined,
      tokens: this.extractTokens(node, variables),
      spacing: this.extractSpacing(node),
      typography: this.extractTypography(node, variables),
      borders: this.extractBorders(node, variables),
      states: isComponentSet
        ? this.extractStatesFromVariants(node, variables)
        : [], // Plain components: states must be found via their parent COMPONENT_SET
    };
  }

  private extractTokens(node: Record<string, unknown>, variables: Record<string, unknown>): DesignTokenMap {
    const tokens: DesignTokenMap = {};
    const fills = node.fills as Array<Record<string, unknown>> | undefined;
    const boundVars = node.boundVariables as Record<string, unknown> | undefined;

    if (fills?.[0]?.type === "SOLID") {
      const fill = fills[0];
      const color = fill.color as { r: number; g: number; b: number; a?: number };
      const hex = this.rgbToHex(color.r, color.g, color.b);
      const tokenRef = (boundVars?.fills as Array<Record<string, unknown>>)?.[0];
      const tokenName = tokenRef
        ? this.resolveVariableName(tokenRef.id as string, variables)
        : undefined;

      tokens.background = {
        raw: hex,
        token: tokenName,
        resolvedValue: hex,
      };
    }

    return tokens;
  }

  private extractSpacing(node: Record<string, unknown>): SpacingSpec {
    return {
      padding: {
        top: (node.paddingTop as number) ?? 0,
        right: (node.paddingRight as number) ?? 0,
        bottom: (node.paddingBottom as number) ?? 0,
        left: (node.paddingLeft as number) ?? 0,
      },
      gap: node.itemSpacing as number | undefined,
      width: node.absoluteBoundingBox
        ? (node.absoluteBoundingBox as { width: number }).width
        : undefined,
      height: node.absoluteBoundingBox
        ? (node.absoluteBoundingBox as { height: number }).height
        : undefined,
      borderRadius: node.cornerRadius as number | undefined,
    };
  }

  private extractTypography(node: Record<string, unknown>, variables: Record<string, unknown>) {
    const style = node.style as Record<string, unknown> | undefined;
    if (!style) return undefined;

    const boundVars = node.boundVariables as Record<string, unknown> | undefined;
    const colorRef = (boundVars?.fills as Array<Record<string, unknown>>)?.[0];
    const fills = node.fills as Array<Record<string, unknown>> | undefined;
    const color = fills?.[0]?.color as { r: number; g: number; b: number } | undefined;

    return {
      fontFamily: style.fontFamily as string,
      fontSize: style.fontSize as number,
      fontWeight: style.fontWeight as number,
      lineHeight: style.lineHeightPx as number,
      letterSpacing: style.letterSpacing as number | undefined,
      color: {
        raw: color ? this.rgbToHex(color.r, color.g, color.b) : "inherit",
        token: colorRef ? this.resolveVariableName(colorRef.id as string, variables) : undefined,
        resolvedValue: color ? this.rgbToHex(color.r, color.g, color.b) : "inherit",
      } satisfies TokenValue,
    };
  }

  private extractBorders(node: Record<string, unknown>, variables: Record<string, unknown>) {
    const strokes = node.strokes as Array<Record<string, unknown>> | undefined;
    if (!strokes?.length) return undefined;

    const stroke = strokes[0];
    const color = stroke.color as { r: number; g: number; b: number } | undefined;
    const boundVars = node.boundVariables as Record<string, unknown> | undefined;
    const strokeRef = (boundVars?.strokes as Array<Record<string, unknown>>)?.[0];

    return {
      width: (node.strokeWeight as number) ?? 1,
      style: "solid",
      color: {
        raw: color ? this.rgbToHex(color.r, color.g, color.b) : "#000",
        token: strokeRef ? this.resolveVariableName(strokeRef.id as string, variables) : undefined,
        resolvedValue: color ? this.rgbToHex(color.r, color.g, color.b) : "#000",
      } satisfies TokenValue,
      radius: node.cornerRadius as number | undefined,
    };
  }

  /**
   * Extract interactive states from COMPONENT_SET variant children.
   * Figma stores variants as children of COMPONENT_SET nodes.
   * Each child's name encodes the variant properties e.g. "State=Hover, Size=Large".
   */
  private extractStatesFromVariants(
    node: Record<string, unknown>,
    variables: Record<string, unknown>
  ): StateSpec[] {
    const children = node.children as Array<Record<string, unknown>> | undefined;
    if (!children) return [];

    const stateNames = ["hover", "focus", "active", "disabled", "error", "pressed"];
    const states: StateSpec[] = [];
    const seenStates = new Set<string>();

    for (const child of children) {
      const name = (child.name as string).toLowerCase();
      // Figma variant names: "State=Hover, Size=Large" or just "Hover"
      const matchedState = stateNames.find(s =>
        name.includes(`state=${s}`) || name.includes(`${s},`) || name === s
      );

      if (matchedState && !seenStates.has(matchedState)) {
        seenStates.add(matchedState);
        states.push({
          name: matchedState,
          overrides: this.extractTokens(child, variables),
        });
      }
    }

    return states;
  }

  private resolveVariableName(variableId: string, variables: Record<string, unknown>): string | undefined {
    const variable = variables[variableId] as Record<string, unknown> | undefined;
    return variable?.name as string | undefined;
  }

  private rgbToHex(r: number, g: number, b: number): string {
    const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
}
