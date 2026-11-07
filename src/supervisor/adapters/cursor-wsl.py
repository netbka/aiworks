"""Cursor research transport: private mounts, PID namespace and durable cleanup."""
import json
import os
import pathlib
import select
import signal
import subprocess
import sys
import threading
import time

MAX_INPUT = 1100000
BOOT = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def atomic(path, value):
    temp = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    with temp.open('w', encoding='utf8') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def identity(pid):
    try:
        text = pathlib.Path('/proc/' + str(pid) + '/stat').read_text()
        tail = text[text.rindex(')') + 2:].split()
        status = pathlib.Path('/proc/' + str(pid) + '/status').read_text()
        namespace_pid = next(int(line.split()[-1]) for line in status.splitlines() if line.startswith('NSpid:'))
        return {'pid': pid, 'start': tail[19], 'boot': BOOT,
                'namespace': os.readlink('/proc/' + str(pid) + '/ns/pid'), 'namespacePid': namespace_pid}
    except (FileNotFoundError, ProcessLookupError):
        return None


def same(record):
    return isinstance(record, dict) and identity(record.get('pid', 0)) == record


def terminate_namespace(record):
    if record.get('namespacePid') != 1 or record.get('namespace') == os.readlink('/proc/self/ns/pid'):
        raise ValueError('not an owned namespace init')
    try:
        handle = os.pidfd_open(record['pid'])
    except ProcessLookupError:
        return
    try:
        # Pin the process before comparing its identity: PID reuse cannot redirect this signal.
        if same(record):
            signal.pidfd_send_signal(handle, signal.SIGKILL)
    except ProcessLookupError:
        pass
    finally:
        os.close(handle)


def namespace_init(child_pid, host_namespace):
    # Bubblewrap can announce its child before that child enters the new namespace.
    # It is still waiting for our startup grant, so waiting here cannot start model work.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        child = identity(child_pid)
        if child and child['namespace'] != host_namespace:
            if child['namespacePid'] == 1:
                return child
            for entry in pathlib.Path('/proc').iterdir():
                if not entry.name.isdecimal():
                    continue
                try:
                    if os.readlink(entry / 'ns/pid') == child['namespace']:
                        candidate = identity(int(entry.name))
                        if candidate and candidate['namespacePid'] == 1:
                            return candidate
                except (FileNotFoundError, ProcessLookupError, PermissionError):
                    pass
        time.sleep(.02)
    raise ValueError('namespace init identity unavailable')


def read_json(path):
    if path.stat().st_size > MAX_INPUT:
        raise ValueError('oversize custody record')
    return json.loads(path.read_text(encoding='utf8'))


def files(request_path):
    root = request_path.parent
    return root / 'wsl-state.json', root / 'wsl-cancel.json'


def drain(request_path, request):
    """Fence late launches first. Unknown ownership never becomes a successful stop."""
    state_path, cancel = files(request_path)
    atomic(cancel, {'nonce': request['nonce']})
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        state = read_json(state_path)
        if state.get('nonce') != request['nonce']:
            return False
        if state.get('phase') in ('reserved', 'finished'):
            return True
        owned = state.get('namespace')
        if owned:
            if owned.get('namespacePid') != 1:
                return False
            if owned.get('boot') != BOOT:
                return True  # A reboot destroyed the prior namespace.
            current = identity(owned.get('pid', 0))
            if current != owned:
                return True  # The exact namespace init exited; never signal a reused PID.
            if owned.get('namespace') == os.readlink('/proc/self/ns/pid'):
                return False
            terminate_namespace(owned)
        elif not same(state.get('guard')):
            return False
        time.sleep(.05)
    return False


def mounted_path(value, directory=True):
    p = pathlib.Path(value)
    if not p.is_absolute() or p.resolve(strict=True) != p:
        raise ValueError('mount source must be canonical')
    if (directory and not p.is_dir()) or (not directory and not p.is_file()):
        raise ValueError('mount source has wrong type')
    return str(p)


def sandbox(request, info_fd):
    paths = request['paths']
    package = mounted_path(paths['package'])
    credential = mounted_path(paths['credential'], False)  # Reference only; never opened here.
    scratch, config, data = [mounted_path(paths[k]) for k in ('scratch', 'config', 'data')]
    bwrap = ['/usr/bin/bwrap', '--unshare-all', '--share-net', '--die-with-parent',
             '--info-fd', str(info_fd), '--ro-bind', '/usr', '/usr',
             '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
             '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
             '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/etc']
    for p in ('/etc/ssl', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf',
              '/etc/passwd', '/etc/group'):
        bwrap += ['--ro-bind', p, p]
    bwrap += ['--ro-bind', package, '/agent', '--bind', scratch, '/work',
              '--bind', config, '/config', '--bind', data, '/data',
              '--ro-bind', credential, '/auth/cursor/auth.json',
              '--ro-bind', str(pathlib.Path(__file__).resolve()), '/bridge.py', '--clearenv']
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/work/home', 'XDG_CONFIG_HOME': '/auth',
           'CURSOR_CONFIG_DIR': '/config', 'CURSOR_DATA_DIR': '/data',
           'TMPDIR': '/tmp', 'TERM': 'dumb', 'NO_COLOR': '1'}
    for key, value in env.items():
        bwrap += ['--setenv', key, value]
    return bwrap + ['--chdir', '/work', '--', '/usr/bin/python3', '-I', '-S', '/bridge.py', 'payload']


def payload():
    # No application runs until the parent has durably recorded this namespace.
    if not select.select([sys.stdin], [], [], 10)[0]:
        raise ValueError('missing startup grant')
    header = sys.stdin.buffer.readline(MAX_INPUT + 1)
    value = json.loads(header)
    if set(value) != {'argv', 'prompt'} or not isinstance(value['prompt'], str):
        raise ValueError('invalid startup grant')
    argv = value['argv']
    if argv[:2] != ['/agent/node', '/agent/index.js']:
        raise ValueError('unexpected worker')
    # A temporary prompt file avoids buffering the model's stdin in this Python process.
    with open('/tmp/worker-prompt', 'w+', encoding='utf8') as stream:
        stream.write(value['prompt'])
        stream.flush()
        stream.seek(0)
        os.dup2(stream.fileno(), 0)
    os.execv(argv[0], argv)


def start(request_path, request):
    state_path, cancel = files(request_path)
    nonce = request['nonce']
    if cancel.exists():
        return 1
    state = {'nonce': nonce, 'phase': 'starting', 'guard': identity(os.getpid())}
    atomic(state_path, state)
    if cancel.exists():
        atomic(state_path, {**state, 'phase': 'finished', 'exitCode': 1})
        return 1
    control = {'at': time.monotonic(), 'error': None, 'start': None}
    ready = threading.Event()

    def receive():
        try:
            first = True
            pending = b''
            while True:
                while b'\n' not in pending:
                    chunk = os.read(0, 65536)
                    if not chunk or len(pending) + len(chunk) > MAX_INPUT:
                        raise ValueError('control pipe closed or malformed')
                    pending += chunk
                line, pending = pending.split(b'\n', 1)
                message = json.loads(line)
                if first:
                    if set(message) != {'nonce', 'prompt'} or message['nonce'] != nonce:
                        raise ValueError('invalid launch identity')
                    if not isinstance(message['prompt'], str):
                        raise ValueError('invalid prompt')
                    control['start'] = message
                    first = False
                    ready.set()
                elif message != {'nonce': nonce, 'heartbeat': True}:
                    raise ValueError('invalid heartbeat')
                control['at'] = time.monotonic()
        except BaseException:
            control['error'] = 'control unavailable'
            ready.set()

    threading.Thread(target=receive, daemon=True).start()
    if not ready.wait(10) or control['error']:
        atomic(state_path, {**state, 'phase': 'finished', 'exitCode': 1, 'reason': 'startup-control'})
        return 1
    read_fd, write_fd = os.pipe()
    child = None
    code = 1
    stage = 'sandbox-prepare'
    failure = None
    try:
        child = subprocess.Popen(sandbox(request, write_fd), stdin=subprocess.PIPE,
                                 stdout=sys.stdout.buffer, stderr=sys.stderr.buffer,
                                 pass_fds=(write_fd,), start_new_session=True)
        os.close(write_fd)
        write_fd = None
        stage = 'namespace-handshake'
        if not select.select([read_fd], [], [], 10)[0]:
            raise ValueError('namespace identity unavailable')
        info = json.loads(os.read(read_fd, 4096))
        stage = 'namespace-identity'
        owned = namespace_init(info['child-pid'], state['guard']['namespace'])
        if not owned or owned['namespace'] == state['guard']['namespace']:
            raise ValueError('PID namespace was not established')
        state.update(phase='running', namespace=owned)
        atomic(state_path, state)
        stage = 'startup-grant'
        if cancel.exists() or control['error'] or time.monotonic() - control['at'] > 5:
            raise ValueError('launch cancelled')
        grant = {'argv': ['/agent/node', '/agent/index.js', *request['argv']],
                 'prompt': control['start']['prompt']}
        child.stdin.write((json.dumps(grant) + '\n').encode())
        child.stdin.close()
        stage = 'worker'
        deadline = time.monotonic() + request['timeoutMs'] / 1000
        while child.poll() is None:
            if cancel.exists() or control['error'] or time.monotonic() - control['at'] > 5:
                raise ValueError('owner disappeared')
            if time.monotonic() >= deadline:
                raise ValueError('worker timeout')
            time.sleep(.05)
        code = child.returncode
    except BaseException:
        code = 1
        failure = stage
    finally:
        os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)
        if child:
            owned = state.get('namespace')
            if owned:
                terminate_namespace(owned)
            if child.poll() is None:
                # Before a startup grant there can be no model work.
                if not owned:
                    child.stdin.close()
                try:
                    child.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=3)
            deadline = time.monotonic() + 12
            while owned and same(owned):
                if time.monotonic() >= deadline:
                    raise ValueError('namespace cleanup not proved')
                time.sleep(.05)
        atomic(state_path, {**state, 'phase': 'finished', 'exitCode': code,
                            **({'reason': failure} if failure else {})})
    return code


def main():
    if sys.argv[1:] == ['payload']:
        payload()
        return 1
    if len(sys.argv) != 3 or sys.argv[1] not in ('run', 'cleanup'):
        raise ValueError('invalid transport command')
    request_path = pathlib.Path(sys.argv[2]).resolve(strict=True)
    request = read_json(request_path)
    if request.get('version') != 1 or not isinstance(request.get('nonce'), str):
        raise ValueError('invalid transport request')
    if sys.argv[1] == 'cleanup':
        stopped = drain(request_path, request)
        print(json.dumps({'version': 1, 'nonce': request['nonce'], 'stopped': stopped}))
        return 0 if stopped else 1
    return start(request_path, request)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        sys.stderr.write('Cursor WSL transport failed: ' + type(error).__name__ + '\n')
        sys.exit(1)
