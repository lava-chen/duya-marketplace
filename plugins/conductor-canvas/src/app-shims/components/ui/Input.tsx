import React from "react";
export function Input({ size: _size, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: string }) {
  return <input {...props} />;
}
