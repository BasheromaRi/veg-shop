app.post('/api/orders', (req, res) => {
  const { items, phone, phone2, country, address, name, notes, deliveryRegion } = req.body;

  const safeItems = Array.isArray(items) ? items : [];

  const cleanSubtotal = Math.round(
    safeItems.reduce((sum, i) => {
      const price = Number(i.price) || 0;
      const qty = Number(i.qty) || 0;
      return sum + (price * qty);
    }, 0)
  );

  if (cleanSubtotal < MIN_ORDER_TOTAL) {
    return res.status(400).json({
      error: `عشان نوصلك الطلب، الحد الأدنى للطلب هو ₪${MIN_ORDER_TOTAL}. المجموع الحالي ₪${cleanSubtotal}. زِد منتجات للطلب وكمل معنا 🌿`
    });
  }

  db.run(
    `INSERT INTO orders (name, phone, phone2, country, address, notes, deliveryRegion, items, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name || '',
      phone || '',
      phone2 || '',
      country || '',
      address || '',
      notes || '',
      deliveryRegion || '',
      JSON.stringify(safeItems),
      'new',
      new Date().toISOString(),
    ],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });

      const orderId = this.lastID;

      const delivery = cleanSubtotal >= 300 ? 0 : 30;
      const total = Math.round(cleanSubtotal + delivery);

      const itemsText = safeItems.map(i => {
        const unit = i.unitType === 'bag' ? 'كيس' : 'كغم';
        const line = Math.round((Number(i.price) || 0) * (Number(i.qty) || 0));
        return `• ${i.name} — ${i.qty} ${unit} — ₪${line}`;
      }).join('\n');

      const msg = `🆕 طلب جديد #${orderId}

👤 الاسم: ${name || '-'}
📞 الهاتف: ${phone || '-'}
📞 هاتف إضافي: ${phone2 || '-'}
📍 البلد: ${country || '-'}
🗺️ المنطقة: ${deliveryRegion || '-'}
🏠 العنوان: ${address || '-'}
📝 ملاحظات: ${notes || '-'}

🛒 المنتجات:
${itemsText || '-'}

💰 المجموع قبل التوصيل: ₪${cleanSubtotal}
🚚 التوصيل: ${delivery === 0 ? 'مجاني ✅' : '₪30'}
✅ المجموع الكلي: ₪${total}`;

      sendTelegramMessage(msg);

      res.json({ success: true, orderId });
    }
  );
});
