import { ChevronDown, ChevronRight } from "lucide-react";
import { Highlight, themes } from "prism-react-renderer";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type FormField, type RequestBody } from "../types";

function useCodeTheme() {
  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute("data-theme") !== "light",
  );
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setIsDark(
        document.documentElement.getAttribute("data-theme") !== "light",
      );
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);
  return isDark ? themes.vsDark : themes.vsLight;
}

interface Props {
  body: RequestBody;
}

function isJson(s: string): boolean {
  const t = s.trim();
  return t.startsWith("{") || t.startsWith("[");
}

function tryFormatJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

const PLACEHOLDER_RE = /(\{\{[^}]*\}\})/g;

function renderTokenWithPlaceholders(
  token: { types: string[]; content: string },
  props: React.HTMLAttributes<HTMLSpanElement>,
  key?: React.Key,
) {
  const parts = token.content.split(PLACEHOLDER_RE);
  if (parts.length === 1)
    return (
      <span key={key} {...props}>
        {token.content}
      </span>
    );
  return (
    <span key={key} {...props}>
      {parts.map((part, i) =>
        PLACEHOLDER_RE.test(part) ? (
          <span key={i} className="placeholder-token">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}

function JsonHighlight({ code }: { code: string }) {
  const codeTheme = useCodeTheme();
  return (
    <Highlight theme={codeTheme} code={code} language="json">
      {({ className, style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={`request-detail-pre request-detail-pre--highlighted ${className}`}
          style={{ ...style, border: "1px solid var(--border)", marginTop: 6 }}
        >
          {tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line })}>
              <span className="request-detail-lineno">{i + 1}</span>
              {line.map((token, k) => {
                const props = getTokenProps({ token });
                return renderTokenWithPlaceholders(token, props, k);
              })}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}

function RawBody({ content }: { content: string }) {
  const json = isJson(content);
  const code = json ? tryFormatJson(content) : content;
  if (!json) return <pre className="request-detail-pre">{code}</pre>;
  return <JsonHighlight code={code} />;
}

function FieldValue({ value }: { value: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (!value) return <span className="formdata-empty">(empty)</span>;

  if (isJson(value)) {
    const formatted = tryFormatJson(value);
    return (
      <div>
        <button
          className="formdata-expand-btn"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? (
            <>
              <ChevronDown size={12} /> {t("jsonCollapse")}
            </>
          ) : (
            <>
              <ChevronRight size={12} /> {t("jsonExpand")}
            </>
          )}
        </button>
        {expanded && <JsonHighlight code={formatted} />}
      </div>
    );
  }

  return <span>{value}</span>;
}

function FieldTable({ fields, label }: { fields: FormField[]; label: string }) {
  const isFormData = label === "FormData";
  return (
    <table className="formdata-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Value</th>
          {isFormData && <th>Type</th>}
        </tr>
      </thead>
      <tbody>
        {fields.map((f, i) => (
          <tr key={i} className={f.type === "file" ? "formdata-row--file" : ""}>
            <td className="formdata-key">{f.key}</td>
            <td className="formdata-value">
              <FieldValue value={f.value} />
            </td>
            {isFormData && (
              <td className="formdata-type">
                {f.type === "file" ? (
                  <span className="formdata-badge formdata-badge--file">
                    file
                  </span>
                ) : (
                  <span className="formdata-badge formdata-badge--text">
                    text
                  </span>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RequestBodyViewer({ body }: Props) {
  if (body.type === "Raw") return <RawBody content={body.content} />;
  if (body.type === "FormData")
    return <FieldTable fields={body.content} label="FormData" />;
  return <FieldTable fields={body.content} label="UrlEncoded" />;
}
