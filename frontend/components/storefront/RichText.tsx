import React from "react";
import { isSafeSectionHref } from "@/lib/sections";

/**
 * Owner-written text with light formatting, rendered as React elements (never
 * as HTML, so nothing an owner types can inject markup):
 * a line starting with "## " is a heading, "- " a bullet, a blank line starts a
 * new paragraph; **bold** and [links](/path) work inside text. Link addresses
 * follow the same rule as buttons; an unsafe one stays as plain text.
 */
const INLINE = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string): React.ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      if (!isSafeSectionHref(link[2])) return <React.Fragment key={index}>{link[1]}</React.Fragment>;
      const external = /^https:/i.test(link[2]);
      return (
        <a key={index} href={link[2]} className="underline underline-offset-4" {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
          {link[1]}
        </a>
      );
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

export default function RichText({ body, headingClass, className = "" }: { body: string; headingClass: string; className?: string }) {
  const blocks = body.replace(/\r\n/g, "\n").split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return (
    <div className={`space-y-4 ${className}`}>
      {blocks.map((block, index) => {
        const lines = block.split("\n");
        if (lines.every((line) => line.startsWith("- "))) {
          return (
            <ul key={index} className="inline-block list-disc space-y-1.5 pl-5 text-left">
              {lines.map((line, i) => <li key={i}>{inline(line.slice(2))}</li>)}
            </ul>
          );
        }
        if (lines.length === 1 && block.startsWith("## ")) {
          return <h3 key={index} className={`pt-2 ${headingClass}`}>{inline(block.slice(3))}</h3>;
        }
        return <p key={index} className="whitespace-pre-line">{inline(block)}</p>;
      })}
    </div>
  );
}
