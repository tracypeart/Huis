"use client";

export default function AppError() {
  return (
    <div className="card">
      <h1>This page isn&apos;t available</h1>
      <p className="sub">You may not have access to it, or something went wrong. If you think you should have access, ask your firm administrator.</p>
      <a href="/dashboard">Back to dashboard</a>
    </div>
  );
}
