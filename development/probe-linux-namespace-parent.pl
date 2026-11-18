# Python測定器と同じ通常pipe条件で、Perl自身が所有する子だけを測る。
use strict;
use warnings;
use utf8;
use Cwd qw(abs_path getcwd);
use Digest::SHA qw(sha256_hex);
use Encode qw(decode);
use Errno qw(EINTR);
use Fcntl qw(:DEFAULT);
use IO::Select;
use JSON::PP;
use POSIX qw(:sys_wait_h strftime _exit);
use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC time sleep);
use Config;
our $SELF = abs_path(__FILE__);
our $FORK_COUNT = 0;
$^F = 2;

# 対象実体と測定器の内容を固定する。
sub digest {
    my ($path) = @_;
    open my $file, '<:raw', $path or die "hash: $!\n";
    local $/;
    return sha256_hex(<$file>);
}

# procの読取り失敗を観測値として残す。
sub read_context {
    my ($path) = @_;
    if (open my $file, '<:raw', $path) {
        local $/;
        my $value = <$file>;
        $value =~ s/^\s+|\s+$//g;
        return { value => $value };
    }
    my $number = 0 + $!;
    return { error => $number == 1 ? 'EPERM' : $number == 13 ? 'EACCES' : $number == 2 ? 'ENOENT' : "ERRNO_$number" };
}

# 動的なCPU時間やcommand lineを含めず、process世代と共通親を照合する。
sub ancestry {
    my @chain;
    my $pid = $$;
    for (1 .. 64) {
        open my $stat, '<:raw', "/proc/$pid/stat" or die "祖先stat: $!\n";
        my $line = <$stat>;
        my ($tail) = $line =~ /^\d+\s+\(.*\)\s+(.*)$/;
        die "祖先statの形式が不正です\n" unless defined $tail;
        my @fields = split /\s+/, $tail;
        my $path = readlink "/proc/$pid/exe";
        my $number = 0 + $!;
        push @chain, {
            pid => 0 + $pid, ppid => 0 + $fields[1],
            processGroup => 0 + $fields[2], session => 0 + $fields[3],
            startTimeTicks => 0 + $fields[19],
            defined($path) ? (path => $path) : (pathError => $number == 1 ? 'EPERM' : $number == 13 ? 'EACCES' : $number == 2 ? 'ENOENT' : "ERRNO_$number"),
        };
        return \@chain if $fields[1] == 0;
        $pid = $fields[1];
    }
    die "祖先列が64件を超えました\n";
}

# 既存Python contextと同じ限定項目を自身から取得する。
sub context {
    my @paths = (
        '/proc/self/uid_map', '/proc/self/gid_map', '/proc/self/attr/current',
        '/sys/module/apparmor/parameters/enabled',
        '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
        '/proc/sys/kernel/unprivileged_userns_clone', '/proc/sys/user/max_user_namespaces',
    );
    my %contexts = map { $_ => read_context($_) } @paths;
    open my $status, '<:raw', '/proc/self/status' or die "status: $!\n";
    my @status = grep { /^(?:Uid|Gid|Groups|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):/ } <$status>;
    chomp @status;
    my $gid_text = $(;
    my $groups_text = $);
    my ($gid) = split /\s+/, $gid_text;
    my %groups = map { (0 + $_) => 1 } split /\s+/, $groups_text;
    my %namespaces = map {
        my $value = readlink "/proc/self/ns/$_";
        die "namespace: $!\n" unless defined $value;
        $_ => $value;
    } qw(user pid mnt);
    return {
        uid => 0 + $<, euid => 0 + $>, gid => 0 + $gid,
        groups => [map { 0 + $_ } sort { $a <=> $b } keys %groups],
        namespaces => \%namespaces, status => \@status, contexts => \%contexts,
        environment => { map { $_ => $ENV{$_} } qw(PATH HOME LANG LC_ALL TMPDIR) },
    };
}

# 各probeのUTC時刻をミリ秒で残す。
sub timestamp {
    my $now = time();
    return strftime('%Y-%m-%dT%H:%M:%S', gmtime($now)) . sprintf('.%03dZ', int(($now - int($now)) * 1000));
}

# 通常pipeで合算上限まで読み、時間切れ・超過時は未回収の所有子だけをkillする。
sub capture {
    my ($executable, $argv, $timeout, $limit, $inherited) = @_;
    $timeout //= 5;
    $limit //= 32 * 1024 * 1024;
    my $started = clock_gettime(CLOCK_MONOTONIC);
    my $result = { argv => $argv, pid => 0, startedAt => timestamp(), status => undef, signal => undef };
    my %buffers = (stdout => '', stderr => '', exec => '');
    my (@handles, $pid, $status);
    my $reaped = 0;
    my $poll = sub {
        return if $reaped || !defined $pid;
        my $waited = waitpid($pid, WNOHANG);
        if ($waited == $pid) {
            $status = $?;
            $reaped = 1;
        } elsif ($waited < 0 && $! != EINTR) {
            $result->{error} //= 'ECHILD';
            $reaped = 1;
        }
    };
    eval {
        pipe(my $out_read, my $out_write) or die "pipe: $!\n";
        push @handles, $out_read, $out_write;
        pipe(my $err_read, my $err_write) or die "pipe: $!\n";
        push @handles, $err_read, $err_write;
        pipe(my $exec_read, my $exec_write) or die "pipe: $!\n";
        push @handles, $exec_read, $exec_write;
        $pid = fork();
        die "fork: $!\n" unless defined $pid;
        if ($pid == 0) {
            eval {
                close $exec_read;
                open STDIN, '<', '/dev/null' or die "stdin: $!\n";
                open STDOUT, '>&', $out_write or die "stdout: $!\n";
                open STDERR, '>&', $err_write or die "stderr: $!\n";
                close $_ for ($out_read, $out_write, $err_read, $err_write);
                chdir '/' or die "cwd: $!\n";
                %ENV = () unless $inherited;
                $SIG{PIPE} = 'DEFAULT';
                $SIG{XFSZ} = 'DEFAULT';
                no warnings 'exec';
                exec { $executable } $executable, @$argv or die "exec: $!\n";
            };
            my $error = $@ || 'exec: unknown';
            syswrite($exec_write, $error, 256);
            _exit(127);
        }
        ++$FORK_COUNT;
        $result->{pid} = $pid;
        close $_ for ($out_write, $err_write, $exec_write);
        my $select = IO::Select->new($out_read, $err_read, $exec_read);
        my %names = (fileno($out_read) => 'stdout', fileno($err_read) => 'stderr', fileno($exec_read) => 'exec');
        while ($select->count && !$result->{error}) {
            my $remaining = $started + $timeout - clock_gettime(CLOCK_MONOTONIC);
            if ($remaining <= 0) { $result->{error} = 'ETIMEDOUT'; last; }
            for my $file ($select->can_read($remaining)) {
                my $count = sysread($file, my $chunk, 65536);
                if (!defined $count) {
                    next if $! == EINTR;
                    $result->{error} = "read: $!";
                    last;
                }
                if ($count == 0) { $select->remove($file); next; }
                my $name = $names{fileno($file)};
                if ($name eq 'exec') {
                    $buffers{exec} .= substr($chunk, 0, 256 - length($buffers{exec}));
                    next;
                }
                my $available = $limit - length($buffers{stdout}) - length($buffers{stderr});
                $buffers{$name} .= substr($chunk, 0, $available);
                if ($count > $available) { $result->{error} = 'ENOBUFS'; last; }
            }
        }
        $result->{error} //= $buffers{exec} if length($buffers{exec});
        $poll->();
        while (!$reaped && !$result->{error}) {
            if (clock_gettime(CLOCK_MONOTONIC) >= $started + $timeout) { $result->{error} = 'ETIMEDOUT'; last; }
            sleep(0.001);
            $poll->();
        }
        1;
    } or $result->{error} //= $@ || 'capture: unknown';
    $poll->();
    if (defined($pid) && !$reaped) {
        kill 'KILL', $pid;
        my $deadline = clock_gettime(CLOCK_MONOTONIC) + 5;
        while (!$reaped && clock_gettime(CLOCK_MONOTONIC) < $deadline) { $poll->(); sleep(0.001) unless $reaped; }
        $result->{error} //= 'wait: ETIMEDOUT' unless $reaped;
    }
    close $_ for grep { defined fileno($_) } @handles;
    if (defined $status) {
        if (WIFSIGNALED($status)) {
            my @signals = split /\s+/, $Config{sig_name};
            $result->{signal} = 'SIG' . ($signals[WTERMSIG($status)] // WTERMSIG($status));
        } else { $result->{status} = WEXITSTATUS($status); }
    }
    $result->{stdout} = decode('UTF-8', $buffers{stdout});
    $result->{stderr} = decode('UTF-8', $buffers{stderr});
    $result->{endedAt} = timestamp();
    $result->{elapsedMs} = (clock_gettime(CLOCK_MONOTONIC) - $started) * 1000;
    return $result;
}

# 同じPerl親から最小argvと成功対照を各3回測る。
sub measure {
    my ($executable, $record, $version) = @_;
    $record //= {};
    my $path = abs_path($executable) // die "実行体が見つかりません\n";
    die "baselineのunshare版がありません\n" unless defined($version) && $version =~ /\S/;
    %$record = (
        runtime => { name => 'perl', version => sprintf('%vd', $^V), path => abs_path($^X), hash => digest(abs_path($^X)), pid => 0 + $$, ppid => 0 + getppid(), cwd => getcwd() },
        ancestry => ancestry(), probeEnvironment => 'empty', controllerHash => digest($SELF),
        unshare => {path => $path, hash => digest($path), version => $version},
        before => context(), cases => [], cwd => '/', stdoutType => 'pipe', stderrType => 'pipe',
    );
    $FORK_COUNT = 0;
    for my $scenario (['minimal', ['--map-current-user', '--', '/usr/bin/true']], ['control', ['--', '/usr/bin/true']]) {
        my $case = { name => $scenario->[0], argv => $scenario->[1], probes => [] };
        push @{$record->{cases}}, $case;
        for my $repetition (1 .. 3) {
            my $probe = capture($path, $case->{argv});
            $probe->{repetition} = $repetition;
            push @{$case->{probes}}, $probe;
        }
    }
    $record->{forkCount} = $FORK_COUNT;
    $record->{after} = context();
    die "測定中にunshareが変わりました\n" unless digest($path) eq $record->{unshare}{hash};
    return $record;
}

# Python baselineが許可した場合だけBashから呼ばれ、途中記録も排他的に保存する。
sub main {
    die "EXECUTABLE OUTPUTが必要です\n" unless @ARGV == 2;
    my ($executable, $output) = @ARGV;
    sysopen my $file, "$output/namespace-parent-perl.json", O_WRONLY | O_CREAT | O_EXCL, 0600 or die "出力を作成できません: $!\n";
    my $record = {};
    my $ok = eval {
        open my $baseline_file, '<:raw', "$output/namespace-parent-python.json" or die "baseline: $!\n";
        my $baseline = do { local $/; decode_json(<$baseline_file>) };
        my $python = $baseline->{measurement};
        my $canonical = JSON::PP->new->canonical;
        die "baselineの再現または実行体が一致しません\n" unless
            $baseline->{schema} eq 'linux-namespace-parent-checkpoint/v1'
            && $baseline->{outcome} eq 'uid-map-eperm'
            && $baseline->{controllerHashes}{perl} eq digest($SELF)
            && $baseline->{runtimeHashes}{perl} eq digest(abs_path($^X))
            && $python->{unshare}{path} eq abs_path($executable)
            && $python->{unshare}{hash} eq digest($executable)
            && $python->{runtime}{ppid} == getppid();
        my $chain = ancestry();
        my @common = @$chain[1 .. $#$chain];
        my @python_common = @{$python->{ancestry}}[1 .. $#{$python->{ancestry}}];
        die "共通親またはcaller条件が一致しません\n" unless
            $canonical->encode(\@common) eq $canonical->encode(\@python_common)
            && $canonical->encode(context()) eq $canonical->encode($python->{before})
            && $canonical->encode($python->{before}) eq $canonical->encode($python->{after});
        measure($executable, $record, $python->{unshare}{version});
        1;
    };
    $record->{error} = $@ || '測定に失敗しました' unless $ok;
    print {$file} JSON::PP->new->canonical->utf8->encode($record), "\n" or die "保存に失敗しました: $!\n";
    close $file or die "保存を完了できません: $!\n";
    return $ok ? 0 : 2;
}

unless (caller) {
    my $status = eval { main() };
    if ($@) { print STDERR $@; exit 2; }
    exit $status;
}
1;
