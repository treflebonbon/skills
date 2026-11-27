package RawCodexLauncher;

use strict;
use warnings;
# The entry points suppress Perl startup injection with -t and pass argv directly to exec.
no warnings 'taint';
use Cwd qw(abs_path);
use Digest::SHA qw(sha256_hex);
use Errno qw(EEXIST ENOENT);
use Fcntl qw(:DEFAULT :mode F_SETFD);
use File::Basename qw(dirname);
use File::Path qw(remove_tree);
use File::Temp qw(tempdir);
use JSON::PP qw(decode_json encode_json);
use POSIX qw(uname);

my $payload = abs_path(dirname(__FILE__) . '/../..');
my @sources = qw(bun-exec-pid-namespace.c bun-exec-launcher.c);
my @tools = qw(/usr/bin/unshare /usr/bin/true /usr/bin/systemd-run);
my $architecture = { x86_64 => 'x64', aarch64 => 'arm64' }->{(uname())[4]};
my $prepare = 'prepare-raw-codex-launcher';

sub read_bytes {
    my ($path, $limit, $mode) = @_;
    sysopen(my $file, $path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or die "open $path: $!\n";
    my @info = stat($file);
    die "ファイルの種類・所有者・mode が不正です: $path\n" unless @info && S_ISREG($info[2]) &&
        (!defined($mode) || ($info[4] == $< && ($info[2] & 07777) == $mode && $info[3] == 1));
    die "ファイルサイズが不正です: $path\n" unless $info[7] > 0 && $info[7] <= $limit;
    my $read = read($file, my $bytes, $info[7] + 1);
    die "ファイルの読み取り中にサイズが変わりました: $path\n" unless defined($read) && $read == $info[7];
    return $bytes;
}

sub cache_directory {
    my ($source_hash) = @_;
    my $base = $ENV{XDG_CACHE_HOME} || ((getpwuid($<))[7] . '/.cache');
    my ($canonical) = $base =~ m{\A(/[^/]+(?:/[^/]+)*)\z};
    die "XDG_CACHE_HOME は正規の絶対 path が必要です\n"
        unless defined($canonical) && $canonical !~ m{/(?:\.|\.\.)(?:/|\z)};
    my $directory = "$canonical/treflebonbon-skills/raw-codex-launcher/$source_hash-linux-$architecture";
    die "launcher は plugin payload 外に準備してください\n" if index($directory, "$payload/") == 0;
    return $directory;
}

sub check_directories {
    my ($path, $create) = @_;
    my $current = '';
    for my $component (split m{/}, substr($path, 1)) {
        $current .= "/$component";
        my @info = lstat($current);
        if (!@info && $create && $! == ENOENT) {
            mkdir($current, 0700) || $! == EEXIST or die "mkdir $current: $!\n";
            @info = lstat($current);
        }
        die "cache directory がありません: $current\n" unless @info;
        die "cache の祖先 directory が保護されていません: $current\n" unless
            S_ISDIR($info[2]) && ($info[4] == 0 || $info[4] == $<) &&
            (!($info[2] & 0022) || ($current eq '/tmp' && $info[4] == 0 && ($info[2] & 01000)));
    }
}

sub read_artifact {
    my ($directory, $source_hash) = @_;
    check_directories($directory, 0);
    my @info = lstat($directory);
    die "launcher cache は本人所有の mode 0700 が必要です\n"
        unless $info[4] == $< && ($info[2] & 07777) == 0700;
    my $record = decode_json(read_bytes("$directory/build.json", 4096, 0600));
    my $binary = read_bytes("$directory/launcher", 8 * 1024 * 1024, 0500);
    my ($type, $machine) = unpack('x16vv', $binary);
    die "対象 architecture の ELF 実行体が必要です\n" unless length($binary) >= 64 &&
        substr($binary, 0, 7) eq "\x7fELF\x02\x01\x01" &&
        ($type == 2 || $type == 3) && $machine == ($architecture eq 'x64' ? 62 : 183);
    die "launcher の source、実行体または環境が記録と一致しません\n" unless ref($record) eq 'HASH' &&
        ($record->{version} // '') eq '1' && ($record->{platform} // '') eq 'linux' &&
        ($record->{arch} // '') eq $architecture && ($record->{sourceHash} // '') eq $source_hash &&
        ($record->{binaryHash} // '') eq sha256_hex($binary);
    return $binary;
}

sub write_bytes {
    my ($path, $bytes) = @_;
    sysopen(my $file, $path, O_WRONLY | O_CREAT | O_EXCL, 0600) or die "open $path: $!\n";
    print {$file} $bytes or die "write $path: $!\n";
    close($file) or die "close $path: $!\n";
}

sub build {
    my ($directory, $source_hash, $sources) = @_;
    require 'syscall.ph';
    umask(0077);
    my $parent = dirname($directory);
    check_directories($parent, 1);
    if (!lstat($directory)) {
        my $temporary = tempdir('.build-XXXXXX', DIR => $parent);
        my $failure = eval {
            for my $i (0 .. $#sources) { write_bytes("$temporary/$sources[$i]", $sources->[$i]); }
            mkdir("$temporary/artifact", 0700) or die "mkdir artifact: $!\n";
            my $artifact = "$temporary/artifact";
            my $binary = "$artifact/launcher";
            local $ENV{TMPDIR} = $temporary;
            system('cc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-DRAW_HOST_LAUNCHER',
                qq(-DPROCESS_PROOF_UNSHARE="$tools[0]"), qq(-DPROCESS_PROOF_TRUE="$tools[1]"),
                qq(-DPROCESS_PROOF_SYSTEMD_RUN="$tools[2]"), "$temporary/$sources[0]", '-o', $binary) == 0
                or die "導入済みの cc と OS の C header/library で launcher をビルドできません\n";
            chmod(0500, $binary) == 1 or die "chmod launcher: $!\n";
            write_bytes("$artifact/build.json", encode_json({ version => 1, platform => 'linux',
                arch => $architecture, sourceHash => $source_hash,
                binaryHash => sha256_hex(read_bytes($binary, 8 * 1024 * 1024, 0500)) }) . "\n");
            read_artifact($artifact, $source_hash);
            # RENAME_NOREPLACE protects even an empty generation published by another process.
            syscall(&SYS_renameat2, -100, $artifact, -100, $directory, 1) == 0 || $! == EEXIST
                or die "launcher cache の排他的な公開に失敗しました: $!\n";
            1;
        } ? '' : $@;
        remove_tree($temporary);
        die $failure if length($failure);
    }
    read_artifact($directory, $source_hash);
    print "$directory\n";
}

sub sealed_memfd {
    my ($name, $bytes, $inherit) = @_;
    require 'syscall.ph';
    # MFD_CLOEXEC | MFD_ALLOW_SEALING, then F_ADD_SEALS with all four write/size/seal bits.
    my $fd = syscall(&SYS_memfd_create, $name, 3);
    die "memfd_create: $!\n" if $fd < 0;
    open(my $snapshot, '+<&=', $fd) or die "open memfd: $!\n";
    syswrite($snapshot, $bytes) == length($bytes) or die "write memfd: $!\n";
    fcntl($snapshot, 1033, 15) or die "seal memfd: $!\n";
    fcntl($snapshot, F_SETFD, 0) or die "inherit memfd: $!\n" if $inherit;
    return $snapshot;
}

sub launch {
    my ($directory, $source_hash, @arguments) = @_;
    my $binary = read_artifact($directory, $source_hash);
    my $snapshot = sealed_memfd('raw-codex-launcher', $binary, 0);
    # Carry internal paths out of band so they do not take space from caller argv at exec.
    my $context = sealed_memfd('raw-codex-context', join("\0", "$payload/lib/bun/run",
        "$payload/lib/bun/verify-raw-codex-launcher.ts", $directory, ''), 1);
    my $executable = '/proc/self/fd/' . fileno($snapshot);
    exec {$executable} 'raw-codex-launcher', '' . fileno($context), @arguments;
    die "exec launcher: $!\n";
}

sub entry {
    my ($mode, @arguments) = @_;
    eval {
        die "Linux x64 / arm64 が必要です\n" unless $^O eq 'linux' && $architecture;
        die "使い方: $prepare\n" if $mode eq 'prepare' && @arguments;
        die "使い方: raw-codex-launcher <prepare.ts> [args...]\n" if $mode eq 'launch' && !@arguments;
        my @contents = map { read_bytes("$payload/tests/fixtures/$_", 1024 * 1024, undef) } @sources;
        my ($source_hash) = sha256_hex(join('', map { sha256_hex($_) } @contents)) =~ /\A([0-9a-f]{64})\z/;
        my $directory = cache_directory($source_hash);
        if ($mode eq 'prepare') { build($directory, $source_hash, \@contents); }
        else { launch($directory, $source_hash, @arguments); }
        1;
    } or do {
        my $error = $@;
        print STDERR "$0: $error";
        print STDERR "準備済み launcher を利用できません。$prepare を明示実行してください。\n" if $mode eq 'launch';
        exit 1;
    };
}

1;
