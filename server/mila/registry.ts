/**
 * registry.ts — the Mila tool registry.
 *
 * One array of every tool the agent can call, plus the mapper to Gemini
 * functionDeclarations. Deliberately SDK-free: emits plain objects matching
 * the Vertex functionDeclaration shape, so nothing here imports @google/genai.
 */

import { z } from "zod";
import type { MilaTool } from "./types";
import { getScoreTool } from "./tools/getScore";
import { getProfileTool } from "./tools/getProfile";
import { listDealsTool } from "./tools/listDeals";
import { getDealTool } from "./tools/getDeal";
import { getRateCardTool } from "./tools/getRateCard";
import { listTasksThreadsTool } from "./tools/listTasksThreads";
import { getAnalyticsTool } from "./tools/getAnalytics";
import { draftReplyTool } from "./tools/draftReply";
import { navigateTool } from "./tools/navigate";
import { getHelpTool } from "./tools/getHelp";
import { getBrandTool } from "./tools/getBrand";
import { getBrandFitTool } from "./tools/getBrandFit";
import { getFirstLookTool } from "./tools/getFirstLook";
import { completeOnboardingStepTool } from "./tools/completeOnboardingStep";
import { requestCreativeTool } from "./tools/requestCreative";
import { creativeIntentsEnabled } from "../studio/config";
import { getShopTool, proposeShopItemTool } from "./tools/shop";
import { shopEnabled } from "../services/shop/config";

export const milaTools: MilaTool[] = [
  getScoreTool,
  getProfileTool,
  listDealsTool,
  getDealTool,
  getRateCardTool,
  listTasksThreadsTool,
  getAnalyticsTool,
  draftReplyTool,
  navigateTool,
  getHelpTool,
  getBrandTool,
  getBrandFitTool,
];

/**
 * Tools offered ONLY in an onboarding conversation (context.type === "onboarding"). The loop
 * appends them to `milaTools` for that turn; they are never declared on any other screen, so a
 * model on the deals screen cannot even name complete_onboarding_step. The tool itself also
 * refuses when no onboarding step is waiting — belt and braces.
 */
export const onboardingTools: MilaTool[] = [getFirstLookTool, completeOnboardingStepTool];

/** Offered only while STUDIO_CREATIVE_INTENTS is on: the direct athlete door into creative work (0072). */
export const creativeTools = (): MilaTool[] => (creativeIntentsEnabled() ? [requestCreativeTool] : []);

/** Offered only while SHOP_V1 is on (Her picks): read her shelf, and get a pick ready for her to add (she taps). */
export const shopTools = (): MilaTool[] => (shopEnabled() ? [getShopTool, proposeShopItemTool] : []);

export function getTool(name: string): MilaTool | undefined {
  return milaTools.find((t) => t.name === name) ?? onboardingTools.find((t) => t.name === name) ?? creativeTools().find((t) => t.name === name) ?? shopTools().find((t) => t.name === name);
}

// ─── zod → Gemini schema ─────────────────────────────────────────────────────

/** Subset of the Vertex Schema shape our tool args need. */
interface GeminiSchema {
  type: "OBJECT" | "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN" | "ARRAY";
  description?: string;
  enum?: string[];
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  nullable?: boolean;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: GeminiSchema;
}

/**
 * Minimal converter covering the zod types tool schemas are allowed to use:
 * object / string / number / boolean / enum / array, plus optional / nullable /
 * default / describe wrappers. Throws on anything else so an unsupported
 * schema fails in tests, not silently at the model boundary.
 */
function zodToGeminiSchema(schema: z.ZodTypeAny): GeminiSchema {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind };
  const describe = (s: GeminiSchema): GeminiSchema =>
    schema.description ? { ...s, description: schema.description } : s;

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return describe({ type: "STRING" });
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return describe({
        type: (schema as unknown as z.ZodNumber).isInt ? "INTEGER" : "NUMBER",
      });
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return describe({ type: "BOOLEAN" });
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return describe({
        type: "STRING",
        enum: (schema as unknown as z.ZodEnum<[string, ...string[]]>).options,
      });
    case z.ZodFirstPartyTypeKind.ZodArray:
      return describe({
        type: "ARRAY",
        items: zodToGeminiSchema(
          (schema as unknown as z.ZodArray<z.ZodTypeAny>).element,
        ),
      });
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return zodToGeminiSchema(
        (def as unknown as { innerType: z.ZodTypeAny }).innerType,
      );
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return {
        ...zodToGeminiSchema(
          (def as unknown as { innerType: z.ZodTypeAny }).innerType,
        ),
        nullable: true,
      };
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.AnyZodObject).shape as Record<
        string,
        z.ZodTypeAny
      >;
      const properties: Record<string, GeminiSchema> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = zodToGeminiSchema(child);
        if (!child.isOptional()) required.push(key);
      }
      const out: GeminiSchema = { type: "OBJECT", properties };
      if (required.length) out.required = required;
      return describe(out);
    }
    default:
      throw new Error(
        `zodToGeminiSchema: unsupported zod type "${def.typeName}"`,
      );
  }
}

/** Map the registry to Vertex functionDeclarations for the model call. */
export function toFunctionDeclarations(
  tools: MilaTool[] = milaTools,
): GeminiFunctionDeclaration[] {
  return tools.map((tool) => {
    const parameters = zodToGeminiSchema(tool.argsSchema);
    // Vertex rejects an OBJECT schema with zero properties — no-arg tools
    // must omit `parameters` entirely.
    const empty =
      parameters.type === "OBJECT" &&
      Object.keys(parameters.properties ?? {}).length === 0;
    return {
      name: tool.name,
      description: tool.description,
      ...(empty ? {} : { parameters }),
    };
  });
}
