;; fold: a stereo triangle wavefolder, a dawn.device/v1 effect.
;;
;;   p1  drive  0..1 → input gain 1..16
;;   p2  mix    0..1 → dry .. folded
;;
;; Assemble with wabt 1.0.39: wat2wasm fold.wat -o fold.wasm
;; The module imports nothing. Its I/O region starts at byte 1024:
;;   1024 params f64[8] · 1088 in left f64[128] · 2112 in right
;;   3136 out left · 4160 out right
(module
  (memory (export "memory") 1 1)

  ;; init(sample rate) → the I/O region's address
  (func (export "init") (param $rate f64) (result i32)
    (i32.const 1024))

  ;; A triangle fold with period 4: 1 - |((x + 1) mod 4) - 2|.
  ;; Inside -1..1 it passes x through; beyond it folds back.
  (func $fold (param $x f64) (result f64)
    (local $t f64)
    (local.set $t (f64.add (local.get $x) (f64.const 1)))
    (local.set $t
      (f64.sub
        (local.get $t)
        (f64.mul
          (f64.const 4)
          (f64.floor (f64.div (local.get $t) (f64.const 4))))))
    (f64.sub
      (f64.const 1)
      (f64.abs (f64.sub (local.get $t) (f64.const 2)))))

  ;; dry + mix × (fold(dry × gain) − dry)
  (func $sample (param $dry f64) (param $gain f64) (param $mix f64) (result f64)
    (f64.add
      (local.get $dry)
      (f64.mul
        (local.get $mix)
        (f64.sub
          (call $fold (f64.mul (local.get $dry) (local.get $gain)))
          (local.get $dry)))))

  ;; process(frames) → 0; frames is always 128
  (func (export "process") (param $frames i32) (result i32)
    (local $i i32)
    (local $at i32)
    (local $gain f64)
    (local $mix f64)
    (local.set $gain
      (f64.add
        (f64.const 1)
        (f64.mul (f64.const 15) (f64.load (i32.const 1024)))))
    (local.set $mix (f64.load (i32.const 1032)))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $frames)))
        (local.set $at (i32.shl (local.get $i) (i32.const 3)))
        (f64.store offset=3136
          (local.get $at)
          (call $sample
            (f64.load offset=1088 (local.get $at))
            (local.get $gain)
            (local.get $mix)))
        (f64.store offset=4160
          (local.get $at)
          (call $sample
            (f64.load offset=2112 (local.get $at))
            (local.get $gain)
            (local.get $mix)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (i32.const 0)))
