/**
 * The old shipment-tracking room is gone: no connection can join a shipment's
 * room, and nothing sends to one.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '../../src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

it('no longer lets a connection join or leave a shipment room', () => {
  const socket = fs.readFileSync(path.join(SRC, 'socket.ts'), 'utf8');
  expect(socket).not.toContain("socket.on('join_shipment_tracking'");
  expect(socket).not.toContain("socket.on('leave_shipment_tracking'");
});

it('sends nothing to a shipment room anywhere', () => {
  for (const file of sourceFiles(SRC)) {
    expect(fs.readFileSync(file, 'utf8')).not.toContain('.to(`shipment:');
  }
});
