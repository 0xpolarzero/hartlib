import { useEffect, useState } from "react";

export function DocsDocument() {
  const [docsHtml, setDocsHtml] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const previousTitle = document.title;
    const previousLang = document.documentElement.lang;
    document.title = "Brief — How chat works";
    document.documentElement.lang = "en";
    void import("@brief/docs").then(({ DOCS_HTML }) => {
      if (active) setDocsHtml(DOCS_HTML);
    });
    return () => {
      active = false;
      document.title = previousTitle;
      document.documentElement.lang = previousLang;
    };
  }, []);

  if (docsHtml === null) return null;

  return (
    <iframe
      srcDoc={docsHtml}
      title="Brief — How chat works"
      style={{ border: 0, display: "block", height: "100dvh", width: "100%" }}
    />
  );
}
