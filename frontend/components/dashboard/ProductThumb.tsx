"use client";

import { useState } from "react";

function getInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
}

export default function ProductThumb({
  imageUrl,
  name,
  sizeClassName = "h-12 w-12",
  className = "",
}: {
  imageUrl?: string | null;
  name: string;
  sizeClassName?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !failed;

  const alt = name.trim() ? name : "Product image";

  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-100 text-slate-500 ring-1 ring-slate-200 ${sizeClassName} ${className}`}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl as string}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden="true" className="select-none font-heading text-lg font-semibold">
          {getInitial(name)}
        </span>
      )}
    </div>
  );
}
