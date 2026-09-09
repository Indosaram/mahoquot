#[test]
fn https_only_urls_reach_platform_opener() {
    let url = "https://localhost:18881/callback?state=a%26b";
    let mut calls = Vec::new();
    super::open_external_url_with(url.into(), |argument| {
        calls.push(argument.to_string());
        Ok(())
    })
    .unwrap();
    assert_eq!(calls, [url]);
    for rejected in [
        "http://localhost:18881",
        "file:///tmp/x",
        "javascript:alert(1)",
        "not a URL",
    ] {
        assert!(
            super::open_external_url_with(rejected.into(), |_| {
                calls.push("unexpected".into());
                Ok(())
            })
            .is_err(),
            "accepted {rejected}"
        );
    }
    assert_eq!(calls, [url]);
    let error = super::open_external_url_with(url.into(), |_| {
        Err(std::io::Error::other("fixture opener failure"))
    })
    .unwrap_err();
    assert!(error.contains("fixture opener failure"));

    if let Ok(url) = std::env::var("MAHOQUOT_REVIEW_EXTERNAL_URL") {
        super::open_external_url(url.clone()).unwrap();
        println!("native external opener dispatched: {url}");
    }
}

#[test]
fn zcode_callbacks_are_consumed_only_by_the_matching_login() {
    let mut callback =
        Some(url::Url::parse("zcode://oauth/callback?code=fixture&state=current").unwrap());
    assert_eq!(
        super::take_matching_zcode_callback(&mut callback, "other"),
        None
    );
    assert!(callback.is_some());
    assert_eq!(
        super::take_matching_zcode_callback(&mut callback, "current"),
        Some("zcode://oauth/callback?code=fixture&state=current".into())
    );
    assert_eq!(
        super::take_matching_zcode_callback(&mut callback, "current"),
        None
    );
}

#[test]
fn zcode_callbacks_with_duplicate_state_are_not_delivered() {
    let mut callback = Some(
        url::Url::parse("zcode://oauth/callback?code=fixture&state=current&state=other").unwrap(),
    );
    assert_eq!(
        super::take_matching_zcode_callback(&mut callback, "current"),
        None
    );
}
