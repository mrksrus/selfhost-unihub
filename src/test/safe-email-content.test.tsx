import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SafeEmailContent } from '@/components/mail/SafeEmailContent';

describe('SafeEmailContent', () => {
  it('renders HTML content in a sandboxed iframe', () => {
    render(
      <SafeEmailContent
        emailId="email-1"
        bodyHtml="<h1>Hello</h1>"
        bodyText={null}
      />
    );

    const iframe = screen.getByTitle('email-email-1');
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    expect(iframe.getAttribute('srcdoc')).toContain('<base target="_blank" />');
    expect(iframe.getAttribute('srcdoc')).toContain("img-src 'self' data: blob:");
    expect(iframe.getAttribute('srcdoc')).toContain('<body><h1>Hello</h1></body>');
  });

  it('blocks remote content by default until the user loads it', () => {
    render(
      <SafeEmailContent
        emailId="email-remote"
        bodyHtml='<p>Hello</p><img src="https://tracker.example/image.png" />'
        bodyText={null}
      />
    );

    const iframe = screen.getByTitle('email-email-remote');
    expect(screen.getByText('Remote images and media are blocked for this email.')).toBeInTheDocument();
    expect(iframe.getAttribute('srcdoc')).toContain("img-src 'self' data: blob:");
    expect(iframe.getAttribute('srcdoc')).not.toContain("img-src 'self' data: blob: http: https:");

    fireEvent.click(screen.getByRole('button', { name: /load remote content/i }));

    expect(screen.queryByText('Remote images and media are blocked for this email.')).not.toBeInTheDocument();
    expect(screen.getByTitle('email-email-remote').getAttribute('srcdoc')).toContain("img-src 'self' data: blob: http: https:");
  });

  it('falls back to plain text when HTML is unavailable', () => {
    render(
      <SafeEmailContent
        emailId="email-2"
        bodyHtml={null}
        bodyText="Plain body"
      />
    );

    expect(screen.getByText('Plain body')).toBeInTheDocument();
  });
});
