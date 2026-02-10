# Testing Plan - Mail Features

## Overview

This document outlines a comprehensive testing plan for email composition, Sent folder syncing, and UI improvements.

---

## 1. Email Composing - Testing Plan

### Status: ✅ **IMPLEMENTED**
- **Frontend**: Compose dialog (mobile + desktop), inline compose for replies
- **Backend**: `POST /api/mail/send` endpoint, SMTP sending via nodemailer
- **Features**: New message, Reply, Forward

### Test Cases

#### 1.1 Basic Compose Functionality
- [ ] **Test**: Open compose dialog from "Compose" button
  - **Expected**: Dialog opens, form is empty
  - **Mobile**: Full-screen dialog at bottom
  - **Desktop**: Centered modal dialog

- [ ] **Test**: Fill in To, Subject, Body fields
  - **Expected**: All fields accept input
  - **Validation**: To field requires valid email format

- [ ] **Test**: Select "From" account (if multiple accounts)
  - **Expected**: Dropdown shows all user's mail accounts
  - **Expected**: Can select different account

- [ ] **Test**: Send email
  - **Expected**: Email sends successfully
  - **Expected**: Success toast appears
  - **Expected**: Dialog closes
  - **Expected**: Form resets

#### 1.2 Reply Functionality
- [ ] **Test**: Click "Reply" button on email
  - **Mobile**: Opens compose dialog
  - **Desktop**: Shows inline compose editor below email
  - **Expected**: "To" field pre-filled with sender
  - **Expected**: Subject prefixed with "Re: "
  - **Expected**: Original email body included in reply

- [ ] **Test**: Send reply
  - **Expected**: Email sends successfully
  - **Expected**: Original email remains in inbox

#### 1.3 Forward Functionality
- [ ] **Test**: Click "Forward" button on email
  - **Mobile**: Opens compose dialog
  - **Desktop**: Shows inline compose editor
  - **Expected**: "To" field empty
  - **Expected**: Subject prefixed with "Fwd: "
  - **Expected**: Original email body included

- [ ] **Test**: Send forwarded email
  - **Expected**: Email sends successfully

#### 1.4 Error Handling
- [ ] **Test**: Send without selecting account
  - **Expected**: Error toast "Please select an account"

- [ ] **Test**: Send with invalid email address
  - **Expected**: Browser/form validation prevents submission

- [ ] **Test**: Send with SMTP authentication failure
  - **Expected**: Error toast with clear message
  - **Expected**: Error details shown (copyable)

- [ ] **Test**: Send with network timeout
  - **Expected**: Error message about timeout
  - **Expected**: Suggestion to check SMTP settings

#### 1.5 UI/UX Testing
- [ ] **Test**: Mobile compose dialog
  - **Expected**: Full-screen bottom sheet
  - **Expected**: Form scrolls properly
  - **Expected**: Keyboard doesn't cover inputs
  - **Expected**: Send button accessible

- [ ] **Test**: Desktop inline compose (reply/forward)
  - **Expected**: Appears below email reader
  - **Expected**: Can scroll compose form
  - **Expected**: Close button works

- [ ] **Test**: Form reset after send
  - **Expected**: All fields cleared
  - **Expected**: Mode reset to "new"

- [ ] **Test**: Cancel button
  - **Expected**: Dialog closes
  - **Expected**: Form resets
  - **Expected**: No email sent

#### 1.6 Edge Cases
- [ ] **Test**: Very long subject line
  - **Expected**: Handles gracefully (no truncation in UI)

- [ ] **Test**: Very long email body
  - **Expected**: Textarea scrolls
  - **Expected**: Email sends successfully

- [ ] **Test**: Special characters in subject/body
  - **Expected**: Handles Unicode, emojis correctly

- [ ] **Test**: Multiple recipients (comma-separated)
  - **Expected**: Accepts multiple emails
  - **Expected**: All recipients receive email

---

## 2. Sent Folder Syncing - Testing Plan

### Status: ❌ **NOT IMPLEMENTED**
- **Current**: Only INBOX folder is synced
- **Needed**: Sync Sent folder from email providers

### Implementation Requirements

#### 2.1 Backend Changes Needed
- [ ] Modify `syncMailAccount()` to sync multiple folders
- [ ] Add folder parameter to sync function
- [ ] Sync "Sent" folder (or "Sent Items" for some providers)
- [ ] Store sent emails with `folder = 'sent'` in database
- [ ] Handle different folder names per provider:
  - Gmail: "Sent"
  - Outlook: "Sent Items"
  - Apple: "Sent Messages"
  - Generic: Try common names

#### 2.2 Sync Strategy
- [ ] Sync INBOX on initial account add
- [ ] Sync Sent folder after INBOX sync completes
- [ ] In 10-minute auto-sync: sync both folders
- [ ] Manual sync: sync both folders

#### 2.3 Test Cases (After Implementation)

- [ ] **Test**: Initial sync includes Sent folder
  - **Expected**: Sent emails appear in Sent folder view
  - **Expected**: Emails show correct metadata

- [ ] **Test**: Sent emails from compose appear in Sent folder
  - **Expected**: After sending, email appears in Sent (if synced)
  - **Note**: May require manual sync or wait for auto-sync

- [ ] **Test**: Sent folder shows correct emails
  - **Expected**: Only emails sent FROM this account
  - **Expected**: Sorted by date (newest first)

- [ ] **Test**: Sent folder sync doesn't duplicate
  - **Expected**: Same email not added twice
  - **Expected**: Uses message_id for duplicate detection

- [ ] **Test**: Multiple providers (Gmail, Apple, etc.)
  - **Expected**: Each provider's Sent folder syncs correctly
  - **Expected**: Folder names handled correctly

#### 2.4 Edge Cases
- [ ] **Test**: Empty Sent folder
  - **Expected**: No errors, shows "No emails" message

- [ ] **Test**: Very large Sent folder (1000+ emails)
  - **Expected**: Syncs last 500 (same as INBOX limit)
  - **Expected**: No timeout errors

---

## 3. UI Testing & Improvements - Testing Plan

### 3.1 General UI Testing

#### Mobile Experience
- [ ] **Test**: Bottom navigation bar
  - **Expected**: Always visible at bottom
  - **Expected**: Icons and labels clear
  - **Expected**: Active state shows correctly
  - **Expected**: Doesn't overlap content

- [ ] **Test**: Mobile header
  - **Expected**: Shows app title
  - **Expected**: Menu dropdown works
  - **Expected**: Settings/Admin/Logout accessible

- [ ] **Test**: Sidebar on mobile
  - **Expected**: Full width (not collapsible)
  - **Expected**: All items visible
  - **Expected**: Doesn't take too much space

- [ ] **Test**: Email list on mobile
  - **Expected**: Readable text sizes
  - **Expected**: Subject/from visible
  - **Expected**: Date visible
  - **Expected**: Unread indicator visible

- [ ] **Test**: Email reader on mobile
  - **Expected**: Full-screen view
  - **Expected**: Back button works
  - **Expected**: Reply/Forward buttons accessible
  - **Expected**: Content scrolls properly

#### Desktop Experience
- [ ] **Test**: Sidebar collapse
  - **Expected**: Collapse button works
  - **Expected**: Icons-only mode functional
  - **Expected**: Tooltips show on hover
  - **Expected**: Smooth transition

- [ ] **Test**: Email list layout
  - **Expected**: Good use of space when sidebar collapsed
  - **Expected**: Email content readable
  - **Expected**: No horizontal scrolling

- [ ] **Test**: Email reader on desktop
  - **Expected**: Inline compose appears below reader
  - **Expected**: Can scroll both reader and compose
  - **Expected**: Close compose works

#### Cross-Device Testing
- [ ] **Test**: Responsive breakpoints
  - **Expected**: Smooth transition between mobile/desktop
  - **Expected**: No layout breaks at 768px breakpoint

- [ ] **Test**: Touch vs mouse
  - **Mobile**: Touch targets large enough
  - **Desktop**: Hover states work
  - **Desktop**: Click targets appropriate size

### 3.2 Email List UI

- [ ] **Test**: Email selection (checkboxes)
  - **Expected**: Checkboxes visible and clickable
  - **Expected**: Ctrl+Click works
  - **Expected**: Shift+Click selects range
  - **Expected**: Select All button works

- [ ] **Test**: Bulk action toolbar
  - **Expected**: Appears when emails selected
  - **Expected**: Shows count "(X selected)"
  - **Expected**: All buttons work (Mark Read, Star, Move, Delete)
  - **Expected**: Disappears when deselected

- [ ] **Test**: Context menu (right-click)
  - **Expected**: Menu appears at cursor
  - **Expected**: All options work
  - **Expected**: Closes on click outside
  - **Expected**: Closes after action

- [ ] **Test**: Keyboard shortcuts
  - **Expected**: Delete key deletes selected
  - **Expected**: Ctrl+A selects all
  - **Expected**: Escape deselects all
  - **Expected**: Doesn't trigger when typing in inputs

- [ ] **Test**: Visual indicators
  - **Expected**: Unread emails have blue dot
  - **Expected**: Unread emails have bold text
  - **Expected**: Selected emails have accent background
  - **Expected**: Attachment icon shows for emails with attachments

### 3.3 Email Reader UI

- [ ] **Test**: Email content display
  - **Expected**: HTML emails render correctly
  - **Expected**: Plain text emails formatted correctly
  - **Expected**: Long emails scroll properly
  - **Expected**: Images (inline) display correctly

- [ ] **Test**: Attachment display
  - **Expected**: Attachments section appears
  - **Expected**: Shows filename, type, size
  - **Expected**: Download links work
  - **Expected**: Inline attachments display in HTML

- [ ] **Test**: Action buttons
  - **Expected**: Reply button works
  - **Expected**: Forward button works
  - **Expected**: Star toggle works
  - **Expected**: Back button closes reader

- [ ] **Test**: Date format
  - **Expected**: Shows full date with year (DD/MM/YYYY)
  - **Expected**: Time in 24-hour format
  - **Expected**: Consistent across all folders

### 3.4 Performance Testing

- [ ] **Test**: Large email list (500+ emails)
  - **Expected**: List loads without lag
  - **Expected**: Scrolling smooth
  - **Expected**: Selection works correctly

- [ ] **Test**: Email with many attachments
  - **Expected**: All attachments load
  - **Expected**: Download works for each

- [ ] **Test**: Email with large HTML content
  - **Expected**: Renders without lag
  - **Expected**: Scrolls smoothly

### 3.5 Accessibility Testing

- [ ] **Test**: Keyboard navigation
  - **Expected**: Tab through all interactive elements
  - **Expected**: Enter/Space activates buttons
  - **Expected**: Escape closes dialogs

- [ ] **Test**: Screen reader compatibility
  - **Expected**: Buttons have labels
  - **Expected**: Form inputs have labels
  - **Expected**: Error messages announced

- [ ] **Test**: Color contrast
  - **Expected**: Text readable on backgrounds
  - **Expected**: Unread indicators visible
  - **Expected**: Selected state clear

### 3.6 Browser Compatibility

- [ ] **Test**: Chrome/Chromium
- [ ] **Test**: Firefox
- [ ] **Test**: Safari (iOS/macOS)
- [ ] **Test**: Edge

---

## 4. Priority Order

### High Priority (Fix First)
1. ✅ Email composing basic functionality
2. ✅ Reply/Forward functionality
3. ✅ Error handling for compose
4. ✅ Mobile compose UI polish
5. ⚠️ Sent folder syncing (not implemented)

### Medium Priority
1. UI improvements based on testing
2. Performance optimizations
3. Accessibility improvements
4. Browser compatibility fixes

### Low Priority (Nice to Have)
1. Rich text editor for compose
2. Attachment support in compose
3. Draft saving
4. Email templates

---

## 5. Testing Checklist Summary

### Compose Testing
- [ ] Basic compose (new message)
- [ ] Reply functionality
- [ ] Forward functionality
- [ ] Error handling
- [ ] Mobile UI
- [ ] Desktop UI
- [ ] Form validation
- [ ] Multiple accounts

### Sent Folder Testing (After Implementation)
- [ ] Sent folder syncs
- [ ] Sent emails appear correctly
- [ ] No duplicates
- [ ] Multiple providers work

### UI Testing
- [ ] Mobile layout
- [ ] Desktop layout
- [ ] Responsive breakpoints
- [ ] Email selection
- [ ] Bulk actions
- [ ] Context menu
- [ ] Keyboard shortcuts
- [ ] Visual indicators
- [ ] Performance
- [ ] Accessibility

---

## 6. Known Issues to Test

1. **Compose**: Check if HTML emails are supported (currently sends as text)
2. **Compose**: Check if attachments can be added (not implemented)
3. **Sent Folder**: Not synced yet - needs implementation
4. **Drafts**: Not saved - compose is lost if dialog closed

---

## Notes

- Test on actual devices (not just browser dev tools)
- Test with real email accounts (Gmail, Apple, etc.)
- Document any bugs found during testing
- Prioritize fixes based on severity and user impact
