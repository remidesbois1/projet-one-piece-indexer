const OPENCV_PATH = '/opencv/opencv.js';

let cv = null;
let ready = false;

function loadOpenCV() {
    return new Promise((resolve, reject) => {
        if (cv && ready) return resolve(cv);

        try {
            importScripts(OPENCV_PATH);
        } catch (e) {
            reject(new Error('Failed to import OpenCV: ' + e.message));
            return;
        }

        if (typeof self.cv === 'undefined') {
            reject(new Error('cv is undefined after importScripts'));
            return;
        }

        if (self.cv.Mat) {
            cv = self.cv;
            ready = true;
            resolve(cv);
            return;
        }

        if (typeof self.cv.onRuntimeInitialized !== 'undefined') {
            const prev = self.cv.onRuntimeInitialized;
            self.cv.onRuntimeInitialized = () => {
                prev();
                cv = self.cv;
                ready = true;
                resolve(cv);
            };
        } else if (typeof self.cv['then'] === 'function') {
            self.cv.then(instance => {
                cv = instance;
                ready = true;
                resolve(cv);
            }).catch(reject);
        } else {
            cv = self.cv;
            ready = true;
            resolve(cv);
        }
    });
}

function imageDataToMat(imageData, cv) {
    const mat = new cv.Mat(imageData.height, imageData.width, cv.CV_8UC4);
    mat.data.set(imageData.data);
    return mat;
}

function toGrayscale(mat, cv) {
    const gray = new cv.Mat();
    if (mat.channels() === 4) {
        cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    } else if (mat.channels() === 3) {
        cv.cvtColor(mat, gray, cv.COLOR_RGB2GRAY);
    } else {
        mat.copyTo(gray);
    }
    return gray;
}

function equalizeHistogram(gray, cv) {
    const eq = new cv.Mat();
    cv.equalizeHist(gray, eq);
    return eq;
}

function detectAndComputeORB(gray, cv, maxFeatures = 2000) {
    const orb = cv.ORB.create(maxFeatures);
    const keypoints = new cv.KeyPointVector();
    const descriptors = new cv.Mat();
    orb.detectAndCompute(gray, new cv.Mat(), keypoints, descriptors);
    orb.delete();
    return { keypoints, descriptors };
}

function matchFeatures(desc1, desc2, cv) {
    const bf = cv.BFMatcher.create(cv.NORM_HAMMING);
    const matches = new cv.DMatchVectorVector();
    bf.knnMatch(desc1, desc2, matches, 2);
    bf.delete();

    const goodMatches = [];
    const RATIO_THRESH = 0.75;

    for (let i = 0; i < matches.size(); i++) {
        const match = matches.get(i);
        if (match.size() >= 2) {
            const m = match.get(0);
            const n = match.get(1);
            if (m.distance < RATIO_THRESH * n.distance) {
                goodMatches.push(m);
            }
        }
    }
    matches.delete();

    return goodMatches;
}

function estimateAffineRANSAC(kp1, kp2, goodMatches, cv) {
    const srcPts = [];
    const dstPts = [];

    for (const m of goodMatches) {
        const pt1 = kp1.get(m.queryIdx).pt;
        const pt2 = kp2.get(m.trainIdx).pt;
        srcPts.push(pt2.x, pt2.y);
        dstPts.push(pt1.x, pt1.y);
    }

    if (srcPts.length < 6) return null;

    const srcMat = cv.matFromArray(srcPts.length / 2, 1, cv.CV_32FC2, srcPts);
    const dstMat = cv.matFromArray(dstPts.length / 2, 1, cv.CV_32FC2, dstPts);

    const inliers = new cv.Mat();
    const affineMat = cv.estimateAffine2D(srcMat, dstMat, inliers, cv.RANSAC, 3.0, 2000, 0.99, 30);

    const inlierCount = cv.countNonZero(inliers);

    srcMat.delete();
    dstMat.delete();
    inliers.delete();

    if (affineMat.empty()) {
        affineMat.delete();
        return null;
    }

    return {
        matrix: affineMat,
        inlierCount,
        totalPoints: srcPts.length / 2,
        confidence: inlierCount / (srcPts.length / 2)
    };
}

function fallbackNCC(grayBw, grayColor, cv) {
    const bwW = grayBw.cols;
    const bwH = grayBw.rows;
    const colW = grayColor.cols;
    const colH = grayColor.rows;

    const scaleH = bwH / colH;
    const scaledW = Math.round(colW * scaleH);
    const scaledColor = new cv.Mat();
    cv.resize(grayColor, scaledColor, new cv.Size(scaledW, bwH));

    const searchRangeX = Math.min(scaledW - bwW, 200);
    const searchRangeY = Math.min(0, 0);

    if (searchRangeX <= 0) {
        const offsetX = Math.round((scaledW - bwW) / 2);
        const mat = cv.Mat.eye(2, 3, cv.CV_64FC1);
        mat.data64F[0] = scaleH;
        mat.data64F[2] = -offsetX * scaleH;
        mat.data64F[4] = scaleH;
        mat.data64F[5] = 0;
        scaledColor.delete();
        return { matrix: mat, inlierCount: 0, totalPoints: 0, confidence: 0.5, fallback: true };
    }

    let bestX = Math.round((scaledW - bwW) / 2);
    let bestNcc = -Infinity;

    const step = 2;
    for (let dx = 0; dx <= searchRangeX; dx += step) {
        const roi = scaledColor.roi(new cv.Rect(dx, 0, bwW, bwH));
        const ncc = computeNCC(grayBw, roi, cv);
        if (ncc > bestNcc) {
            bestNcc = ncc;
            bestX = dx;
        }
        roi.delete();
    }

    for (let dx = Math.max(0, bestX - step); dx <= Math.min(searchRangeX, bestX + step); dx++) {
        if (dx === bestX) continue;
        const roi = scaledColor.roi(new cv.Rect(dx, 0, bwW, bwH));
        const ncc = computeNCC(grayBw, roi, cv);
        if (ncc > bestNcc) {
            bestNcc = ncc;
            bestX = dx;
        }
        roi.delete();
    }

    scaledColor.delete();

    const mat = cv.Mat.eye(2, 3, cv.CV_64FC1);
    mat.data64F[0] = scaleH;
    mat.data64F[2] = -bestX * scaleH;
    mat.data64F[4] = scaleH;
    mat.data64F[5] = 0;

    return { matrix: mat, inlierCount: 0, totalPoints: 0, confidence: bestNcc, fallback: true };
}

function computeNCC(mat1, mat2, cv) {
    const m1 = new cv.Mat();
    const m2 = new cv.Mat();
    mat1.convertTo(m1, cv.CV_32F);
    mat2.convertTo(m2, cv.CV_32F);

    const mean1 = new cv.Mat();
    const mean2 = new cv.Mat();
    const stddev1 = new cv.Mat();
    const stddev2 = new cv.Mat();
    cv.meanStdDev(m1, mean1, stddev1);
    cv.meanStdDev(m2, mean2, stddev2);

    const s1 = stddev1.data64F[0];
    const s2 = stddev2.data64F[0];
    if (s1 < 1e-6 || s2 < 1e-6) {
        m1.delete(); m2.delete(); mean1.delete(); mean2.delete(); stddev1.delete(); stddev2.delete();
        return 0;
    }

    const mu1 = mean1.data64F[0];
    const mu2 = mean2.data64F[0];

    cv.subtract(m1, new cv.Scalar(mu1), m1);
    cv.subtract(m2, new cv.Scalar(mu2), m2);

    const num = new cv.Mat();
    cv.multiply(m1, m2, num);
    const numerator = cv.sum(num).data32F[0];

    m1.delete(); m2.delete(); mean1.delete(); mean2.delete(); stddev1.delete(); stddev2.delete(); num.delete();

    return numerator / (s1 * s2 * mat1.rows * mat1.cols);
}

self.addEventListener('message', async (event) => {
    const { type } = event.data;

    if (type === 'init') {
        try {
            await loadOpenCV();
            self.postMessage({ status: 'ready' });
        } catch (err) {
            self.postMessage({ status: 'error', error: err.message });
        }
    }

    if (type === 'align') {
        const { bwImageData, colorImageData, pageId } = event.data;

        if (!cv) {
            self.postMessage({ status: 'error', error: 'OpenCV not loaded', pageId });
            return;
        }

        let bwMat, colorMat, grayBw, grayColor, eqBw, eqColor;
        let kp1, desc1, kp2, desc2;
        let result = null;

        try {
            bwMat = imageDataToMat(bwImageData, cv);
            colorMat = imageDataToMat(colorImageData, cv);

            grayBw = toGrayscale(bwMat, cv);
            grayColor = toGrayscale(colorMat, cv);

            eqBw = equalizeHistogram(grayBw, cv);
            eqColor = equalizeHistogram(grayColor, cv);

            const feat1 = detectAndComputeORB(eqBw, cv, 2000);
            const feat2 = detectAndComputeORB(eqColor, cv, 2000);
            kp1 = feat1.keypoints;
            desc1 = feat1.descriptors;
            kp2 = feat2.keypoints;
            desc2 = feat2.descriptors;

            const numKp1 = kp1.size();
            const numKp2 = kp2.size();

            self.postMessage({
                status: 'progress',
                pageId,
                step: 'features',
                keypoints_bw: numKp1,
                keypoints_color: numKp2
            });

            let affineResult = null;
            let usedFallback = false;

            if (desc1.rows >= 2 && desc2.rows >= 2) {
                const goodMatches = matchFeatures(desc1, desc2, cv);

                self.postMessage({
                    status: 'progress',
                    pageId,
                    step: 'matching',
                    good_matches: goodMatches.length
                });

                if (goodMatches.length >= 6) {
                    affineResult = estimateAffineRANSAC(kp1, kp2, goodMatches, cv, pageId);

                    if (affineResult) {
                        self.postMessage({
                            status: 'progress',
                            pageId,
                            step: 'ransac',
                            inliers: affineResult.inlierCount,
                            total: affineResult.totalPoints,
                            confidence: Math.round(affineResult.confidence * 100) / 100
                        });
                    }
                }
            }

            if (!affineResult || affineResult.confidence < 0.3) {
                if (affineResult) affineResult.matrix.delete();
                affineResult = fallbackNCC(grayBw, grayColor, cv);
                usedFallback = true;

                self.postMessage({
                    status: 'progress',
                    pageId,
                    step: 'fallback_ncc',
                    confidence: Math.round(affineResult.confidence * 100) / 100
                });
            }

            const mat = affineResult.matrix;
            const transform = [
                mat.data64F[0], mat.data64F[1], mat.data64F[2],
                mat.data64F[3], mat.data64F[4], mat.data64F[5]
            ];

            result = {
                status: 'complete',
                pageId,
                transform,
                stats: {
                    keypoints_bw: numKp1,
                    keypoints_color: numKp2,
                    good_matches: affineResult.totalPoints,
                    inliers: affineResult.inlierCount,
                    confidence: Math.round(affineResult.confidence * 100) / 100,
                    fallback: usedFallback
                }
            };

            self.postMessage(result);

            mat.delete();
        } catch (err) {
            self.postMessage({ status: 'error', error: err.message, pageId });
        } finally {
            if (bwMat) bwMat.delete();
            if (colorMat) colorMat.delete();
            if (grayBw) grayBw.delete();
            if (grayColor) grayColor.delete();
            if (eqBw) eqBw.delete();
            if (eqColor) eqColor.delete();
            if (kp1) kp1.delete();
            if (desc1) desc1.delete();
            if (kp2) kp2.delete();
            if (desc2) desc2.delete();
        }
    }
});
