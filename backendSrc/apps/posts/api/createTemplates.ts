import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { templatesTable } from "../models/Template";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../../..";

const RequestSchema = z.object({
  id: z.string().uuid().optional(),
  content: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]),
});

export class CreateTemplateApi extends OpenAPIRoute {
  schema = {
    // security: [
    //   {
    //     BearerAuth: [],
    //   },
    // ],
    tags: ["templates"],
    summary: "Create a new template",
    requestBody: {
      content: {
        "application/json": {
          schema: {
            type: "object" as const,
            properties: {
              id: { type: "string" as const },
              content: {
                oneOf: [
                  { type: "string" as const },
                  { type: "object" as const },
                  { type: "array" as const },
                ],
              },
            },
          },
        },
      },
    },
    responses: {
      "201": { description: "Template created successfully" },
      "400": { description: "Bad request" },
      "500": { description: "Internal server error" },
    },
  };

  async handle(request: Request, env: Env) {
    const db = drizzle(env.DB);

    try {
      const body = await request.json();
      const { id, content } = RequestSchema.parse(body);

      // Remove heavy/unsafe fields to avoid oversized payloads and scripts
      const sanitize = (value: unknown): unknown => {
        if (Array.isArray(value)) {
          return value.map(sanitize);
        }
        if (value && typeof value === "object") {
          const input = value as Record<string, unknown>;
          const output: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(input)) {
            if (k === "elementScript") continue;
            output[k] = sanitize(v);
          }
          return output;
        }
        return value;
      };

      const sanitizedContent = sanitize(content);

      const contentForDb = JSON.stringify(sanitizedContent)
        .replace(/<script>/g, "&lt;script&gt;")
        .replace(/<\/script>/g, "&lt;/script&gt;");

      const templateId = id ?? crypto.randomUUID();

      // Ограничим размер записываемого контента (защитимся от слишком больших payloads)
      const maxBytes = 900 * 1024; // ~900KB запасом до 1MB
      if (new Blob([contentForDb]).size > maxBytes) {
        return Response.json(
          { error: "Payload too large", details: "content exceeds size limit" },
          { status: 413 },
        );
      }

      // Явная вставка через D1 prepare + bind, чтобы избежать странностей драйвера
      try {
        await env.DB.prepare("INSERT INTO templates_table (id, content) VALUES (?, ?)")
          .bind(templateId, contentForDb)
          .run();
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        if (/unique constraint failed|UNIQUE constraint failed/i.test(message)) {
          return Response.json(
            { error: "Duplicate id", details: "Template with this id already exists" },
            { status: 409 },
          );
        }
        throw e;
      }

      const result = await env.DB.prepare("SELECT * FROM templates_table WHERE id = ?")
        .bind(templateId)
        .first();

      if (!result) {
        throw new Error("Failed to fetch inserted template");
      }

      return Response.json(result, { status: 201 });
    } catch (error) {
      console.error("CreateTemplateApi error:", error);

      if (error instanceof z.ZodError) {
        return Response.json(
          { error: "Validation failed", details: error.errors },
          { status: 400 },
        );
      }

      return Response.json(
        { error: "Internal server error", details: (error as Error)?.message ?? String(error) },
        { status: 500 },
      );
    }
  }
}
