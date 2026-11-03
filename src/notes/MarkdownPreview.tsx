// 笔记预览：把 markdownModel 解析出的块 / 行内 token 渲染成 React 元素。
// 不使用 innerHTML，用户输入的正文不会变成可执行 HTML。
// 对照 Netcatty InlineMarkdownEditor：笔记里的 `[名称](ssh://user@host:port)` 链接
// 点击即打开对应主机会话（README 里记录的关联主机语义）。
import type { ReactNode } from "react";
import { parseInline, parseMarkdown } from "./markdownModel";

interface Props {
  content: string;
  /** 点击 `ssh://` 链接时调用；由上层按 host/port 匹配主机档案。 */
  onOpenHostHref?: (href: string) => void;
}

function renderInline(text: string, onOpenHostHref?: (href: string) => void): ReactNode[] {
  return parseInline(text).map((token, index) => {
    switch (token.type) {
      case "bold":
        return <strong key={index}>{token.text}</strong>;
      case "italic":
        return <em key={index}>{token.text}</em>;
      case "code":
        return (
          <code key={index} className="notes-md-code-inline">
            {token.text}
          </code>
        );
      case "link": {
        const isHost = token.href.startsWith("ssh://") || token.href.startsWith("telnet://");
        if (isHost && onOpenHostHref) {
          return (
            <button
              key={index}
              type="button"
              className="notes-md-link notes-md-host-link"
              title={`打开会话：${token.href}`}
              onClick={() => onOpenHostHref(token.href)}
            >
              {token.text}
            </button>
          );
        }
        return (
          <span key={index} className="notes-md-link" title={token.href}>
            {token.text}
          </span>
        );
      }
      default:
        return <span key={index}>{token.text}</span>;
    }
  });
}

export function MarkdownPreview({ content, onOpenHostHref }: Props) {
  if (!content.trim()) {
    return <p className="notes-md-empty">正文为空</p>;
  }
  return (
    <div className="notes-md">
      {parseMarkdown(content).map((block, index) => {
        switch (block.type) {
          case "heading": {
            const Tag = (`h${block.level}` as "h1" | "h2" | "h3");
            return <Tag key={index}>{renderInline(block.text, onOpenHostHref)}</Tag>;
          }
          case "paragraph":
            return <p key={index}>{renderInline(block.text, onOpenHostHref)}</p>;
          case "list":
            return block.ordered ? (
              <ol key={index}>
                {block.items.map((item, i) => (
                  <li key={i}>{renderInline(item, onOpenHostHref)}</li>
                ))}
              </ol>
            ) : (
              <ul key={index}>
                {block.items.map((item, i) => (
                  <li key={i}>{renderInline(item, onOpenHostHref)}</li>
                ))}
              </ul>
            );
          case "quote":
            return <blockquote key={index}>{renderInline(block.text, onOpenHostHref)}</blockquote>;
          case "code":
            return (
              <pre key={index} className="notes-md-code">
                <code>{block.text}</code>
              </pre>
            );
          case "hr":
            return <hr key={index} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
