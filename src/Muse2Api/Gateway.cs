using System.Runtime.CompilerServices;

namespace Muse2Api;

/// <summary>Runs driver calls on pooled accounts, retrying only before output is emitted.</summary>
public sealed class Gateway
{
    private readonly AccountPool _pool;
    private readonly IMuseDriver _driver;
    private readonly int _maxFailover;
    private static readonly Account Anonymous = new() { Id = "anonymous", Label = "driver without accounts" };

    public Gateway(AccountPool pool, IMuseDriver driver, int maxFailover = 2)
    {
        _pool = pool; _driver = driver; _maxFailover = maxFailover;
    }

    public async IAsyncEnumerable<string> ChatStream(ChatRequest req, Action<string>? noteAccount = null,
        [EnumeratorCancellation] CancellationToken cancel = default)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(req.Cancel, cancel);
        req = req with { Cancel = linked.Token };
        // v0.8.2: session đã chọn tài khoản thì ép đúng tài khoản đó
        // (AcquirePinnedAsync, không failover sang tài khoản khác).
        var pinned = !string.IsNullOrWhiteSpace(req.AccountId);
        var tried = new List<string>();
        for (var attempt = 0; attempt <= _maxFailover; attempt++)
        {
            using var lease = pinned
                ? await _pool.AcquirePinnedAsync(req.AccountId!, req.ConversationHint, "chat", linked.Token)
                : await LeaseFor(tried, req.ConversationHint, "chat", linked.Token);
            // An abandoned stream is neither a successful request nor an
            // upstream failure. Only mark success after full enumeration.
            lease.Fail(new OperationCanceledException());
            noteAccount?.Invoke(lease.Account.Id);
            var emitted = false;
            UpstreamException? failure = null;
            await using (var stream = StreamDriver(lease.Account, req).GetAsyncEnumerator(linked.Token))
            {
                while (true)
                {
                    bool moved;
                    try
                    {
                        linked.Token.ThrowIfCancellationRequested();
                        moved = await stream.MoveNextAsync();
                    }
                    catch (UpstreamException ex) { lease.Fail(ex); failure = ex; break; }
                    catch (Exception ex) { lease.Fail(ex); throw; }
                    if (!moved) break;
                    if (stream.Current.Length == 0) continue;
                    emitted = true;
                    yield return stream.Current;
                }
            }
            if (failure is null) { lease.Error = null; yield break; }
            // v0.8.2: tài khoản đã ép thì lỗi là lỗi của đúng tài khoản
            // đó, KHÔNG retry sang tài khoản khác rồi im lặng.
            if (pinned) throw failure;
            tried.Add(lease.Account.Id);
            // Local operations must stay in their original conversation. Even a
            // buffered response may already have been submitted upstream.
            if (req.LocalTools || emitted || !ShouldRetry(failure, attempt, tried)) throw failure;
            lease.Dispose();
        }
    }

    private async IAsyncEnumerable<string> StreamDriver(Account account, ChatRequest req,
        [EnumeratorCancellation] CancellationToken cancel = default)
    {
        // Defer even a synchronous driver exception into MoveNextAsync, where
        // the retry loop can apply the same lease/failover handling.
        await foreach (var delta in _driver.ChatStream(account, req).WithCancellation(cancel)) yield return delta;
    }

    public Task<(List<MediaResult> Results, string AccountId)> GenerateImage(ImageRequest req)
        => Run(acc => _driver.GenerateImage(acc, req), "image", req.Cancel);

    public Task<(MediaResult Result, string AccountId)> GenerateVideo(VideoRequest req)
        => Run(acc => _driver.GenerateVideo(acc, req), "video", req.Cancel);

    private async Task<(T Result, string AccountId)> Run<T>(Func<Account, Task<T>> fn, string kind, CancellationToken cancel)
    {
        var tried = new List<string>();
        for (var attempt = 0; attempt <= _maxFailover; attempt++)
        {
            using var lease = await LeaseFor(tried, null, kind, cancel);
            try { return (await fn(lease.Account), lease.Account.Id); }
            catch (UpstreamException ex)
            {
                lease.Fail(ex);
                tried.Add(lease.Account.Id);
                if (!ShouldRetry(ex, attempt, tried)) throw;
            }
            catch (Exception ex) { lease.Fail(ex); throw; }
        }
        throw MuseException.NoAccount();
    }

    private Task<Lease> LeaseFor(List<string> tried, string? hint, string kind, CancellationToken cancel)
    {
        cancel.ThrowIfCancellationRequested();
        return !_driver.RequiresAccount && _pool.All().Count == 0
            ? Task.FromResult(new Lease(_pool, Anonymous))
            : _pool.AcquireAsync(tried, hint, kind, cancel);
    }

    private bool ShouldRetry(UpstreamException ex, int attempt, List<string> tried)
        => ex.Retryable && attempt < _maxFailover && _pool.HasAlternative(tried);
}
