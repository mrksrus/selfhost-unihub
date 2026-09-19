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
    expect(iframe.getAttribute('srcdoc')).toContain("/api/mail/attachments/ data:");
    expect(iframe.getAttribute('srcdoc')).toContain('<body><h1>Hello</h1></body>');
  });

  it('blocks remote content by default until the user loads it', () => {
    render(
      <SafeEmailContent
        emailId="email-remote"
        bodyHtml='<p>Hello</p><img src="https://images.example/photo.png" />'
        bodyText={null}
      />
    );

    const iframe = screen.getByTitle('email-email-remote');
    expect(screen.getByText(/Remote images are blocked for this email/)).toBeInTheDocument();
    expect(iframe.getAttribute('srcdoc')).toContain("/api/mail/attachments/ data:");
    expect(iframe.getAttribute('srcdoc')).not.toContain("/api/mail/attachments/ data: http: https:");

    fireEvent.click(screen.getByRole('button', { name: /load remote images/i }));

    expect(screen.queryByText(/Remote images are blocked for this email/)).not.toBeInTheDocument();
    expect(screen.getByTitle('email-email-remote').getAttribute('srcdoc')).toContain("/api/mail/attachments/ data: http: https:");
  });

  it('can re-block images and resets consent and filtering after navigating back', () => {
    const body = '<img src="https://images.example/photo.png"><img src="https://images.example/pixel.gif">';
    const view = render(<SafeEmailContent emailId="a" bodyHtml={body} bodyText={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load remote images' }));
    expect(screen.getByTitle('email-a').getAttribute('srcdoc')).toContain('photo.png');
    expect(screen.getByTitle('email-a').getAttribute('srcdoc')).not.toContain('pixel.gif');
    fireEvent.click(screen.getByRole('checkbox', { name: /Block suspected tracking images/ }));
    expect(screen.getByTitle('email-a').getAttribute('srcdoc')).toContain('pixel.gif');
    fireEvent.click(screen.getByRole('button', { name: 'Block remote images again' }));
    expect(screen.getByTitle('email-a').getAttribute('srcdoc')).not.toContain('photo.png');
    fireEvent.click(screen.getByRole('button', { name: 'Load remote images' }));
    view.rerender(<SafeEmailContent emailId="b" bodyHtml={body} bodyText={null} />);
    view.rerender(<SafeEmailContent emailId="a" bodyHtml={body} bodyText={null} />);
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByTitle('email-a').getAttribute('srcdoc')).not.toContain('photo.png');
    expect(screen.getByRole('button', { name: 'Load remote images' })).toBeInTheDocument();
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
