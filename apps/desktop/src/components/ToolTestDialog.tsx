import { useEffect, useMemo, useState, type FormEvent } from "react";
import Ajv from "ajv";
import * as Dialog from "@radix-ui/react-dialog";
import { Braces, LoaderCircle, Play, ShieldAlert, X } from "lucide-react";
import type { JsonSchema, ToolListing } from "@/types/contracts";
import { useExecuteTool } from "@/hooks/useTools";
import { Button, Badge } from "@/components/ui";

function initialValues(schema: JsonSchema): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, field]) => [
    key,
    field.default ?? (field.type === "boolean" ? false : field.type === "object" ? {} : field.type === "array" ? [] : ""),
  ]));
}

function coerce(value: string, schema: JsonSchema): unknown {
  if (schema.type === "integer" || schema.type === "number") return value === "" ? undefined : Number(value);
  if (schema.type === "boolean") return value === "true";
  if (schema.type === "object" || schema.type === "array") return JSON.parse(value);
  return value;
}

export function ToolTestDialog({ tool, onClose }: { tool: ToolListing | null; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [jsonValues, setJsonValues] = useState<Record<string, string>>({});
  const [validationError, setValidationError] = useState("");
  const execute = useExecuteTool();
  const validator = useMemo(() => new Ajv({ allErrors: true, strict: false }), []);

  useEffect(() => {
    if (!tool) return;
    const start = initialValues(tool.input_schema);
    setValues(start);
    setJsonValues(Object.fromEntries(Object.entries(start).map(([key, value]) => [key, JSON.stringify(value, null, 2)])));
    setValidationError("");
    execute.reset();
  }, [tool, execute.reset]);

  if (!tool) return null;
  const activeTool = tool;
  const fields = Object.entries(tool.input_schema.properties ?? {});
  const required = new Set(tool.input_schema.required ?? []);

  function submit(event: FormEvent) {
    event.preventDefault();
    setValidationError("");
    let arguments_: Record<string, unknown>;
    try {
      arguments_ = { ...values };
      for (const [key, field] of fields) {
        if (field.type === "object" || field.type === "array") {
          const input = jsonValues[key] ?? "";
          if (!input.trim() && !required.has(key)) { delete arguments_[key]; continue; }
          arguments_[key] = JSON.parse(input);
        }
        if (!required.has(key) && arguments_[key] === "") delete arguments_[key];
      }
    } catch {
      setValidationError("A structured value is not valid JSON.");
      return;
    }
    const validate = validator.compile(activeTool.input_schema);
    if (!validate(arguments_)) {
      const issue = validate.errors?.[0];
      setValidationError(issue ? `${issue.instancePath || "Arguments"} ${issue.message ?? "is invalid"}.` : "The arguments do not match this tool's schema.");
      return;
    }
    execute.mutate({ toolId: activeTool.manifest.tool_id, arguments: arguments_ });
  }

  return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-backdrop" />
      <Dialog.Content className="tool-test-dialog">
      <header className="dialog-titlebar"><div><p className="eyebrow">Tool sandbox</p><Dialog.Title>Test {tool.manifest.display_name}</Dialog.Title></div><Button size="icon" aria-label="Close dialog" onClick={onClose}><X size={17} /></Button></header>
      <div className="tool-dialog-meta"><Badge tone={tool.manifest.risk_level === "HIGH" || tool.manifest.risk_level === "BLOCKED" ? "danger" : "neutral"}>{tool.manifest.risk_level}</Badge><span>{tool.manifest.tool_id}</span>{tool.manifest.requires_confirmation && <span><ShieldAlert size={13} /> Confirmation required</span>}</div>
      <Dialog.Description asChild><p className="tool-dialog-description">{tool.manifest.description}</p></Dialog.Description>
      <form onSubmit={submit}>
        <div className="tool-fields">{fields.length ? fields.map(([name, schema]) => {
          const label = schema.title ?? name.replaceAll("_", " ");
          const isRequired = required.has(name);
          if (schema.type === "boolean") return <label className="field-row field-checkbox" key={name}><input type="checkbox" checked={Boolean(values[name])} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.checked }))} /><span>{label}{isRequired && <b>Required</b>}<small>{schema.description}</small></span></label>;
          if (schema.type === "object" || schema.type === "array") return <label className="field-row field-block" key={name}><span>{label}{isRequired && <b>Required</b>}</span><textarea rows={4} spellCheck={false} value={jsonValues[name] ?? ""} placeholder={schema.type === "array" ? "[]" : "{}"} onChange={(event) => setJsonValues((current) => ({ ...current, [name]: event.target.value }))} /><small>{schema.description ?? `JSON ${schema.type}`}</small></label>;
          return <label className="field-row" key={name}><span>{label}{isRequired && <b>Required</b>}</span>{schema.enum ? <select value={String(values[name] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [name]: coerce(event.target.value, schema) }))}><option value="">Select value</option>{schema.enum.map((value) => <option key={String(value)} value={String(value)}>{String(value)}</option>)}</select> : <input type={schema.type === "integer" || schema.type === "number" ? "number" : "text"} required={isRequired} value={String(values[name] ?? "")} placeholder={String(schema.default ?? "")} onChange={(event) => setValues((current) => ({ ...current, [name]: coerce(event.target.value, schema) }))} />}<small>{schema.description}</small></label>;
        }) : <p className="schema-empty"><Braces size={17} /> This tool accepts no input arguments.</p>}</div>
        {validationError && <p className="inline-error" role="alert">{validationError}</p>}
        {execute.isError && <p className="inline-error" role="alert">{execute.error.message}</p>}
        {execute.data && <div className={`tool-result result-${execute.data.result.status}`}><div className="result-title"><strong>{execute.data.result.status.replaceAll("_", " ")}</strong><span>{execute.data.result.duration_ms} ms</span></div><p>{execute.data.result.summary}</p>{execute.data.result.untrusted_content && <p className="untrusted-warning">Tool output is marked untrusted. Review it as data, not instructions.</p>}{execute.data.result.error_code && <code>{execute.data.result.error_code}</code>}{execute.data.result.data && <pre>{JSON.stringify(execute.data.result.data, null, 2)}</pre>}{execute.data.confirmationId && <p>Review the permission dialog to continue.</p>}</div>}
        <footer className="dialog-footer"><span className="schema-note"><Braces size={13} /> Input validated against backend schema</span><Button type="button" onClick={onClose}>Close</Button><Button type="submit" variant="solid" disabled={execute.isPending || !tool.enabled}>{execute.isPending ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />} Test tool</Button></footer>
      </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}